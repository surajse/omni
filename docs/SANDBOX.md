# Omni Sandbox (v1.0)

Each agent can get **its own computer**: one Docker container plus one
persistent volume. v1.0 hardens the container with restrictive defaults
(see Threat model below).

## Model

| Concept | Implementation |
|---|---|
| Container | `omni-<agentId>` — created from `OMNI_SANDBOX_IMAGE` (default `ubuntu:24.04`), runs `sleep infinity` |
| Disk | `omni-<agentId>-data` volume mounted at `/home/agent` — survives container recreation |
| Access | `computer.exec`, `computer.read_file`, `computer.write_file` tools on the agent's `ToolGateway` |
| Backend | Shells out to the `docker` CLI (`DockerRuntime`); no Docker SDK dependency |

`ContainerRuntime` is an interface (`ensureReady / create / start / stop /
remove / exec / status`), so the backend is swappable. `MockRuntime` is an
in-memory fake used by all tests.

## Usage

```sh
# One-off command in the agent's sandbox (Docker required)
omni sandbox exec friday "ls -la /home/agent"

# Channels and the routine daemon attach the sandbox automatically when
# Docker is available, and warn + continue without it when it isn't.
omni telegram friday
omni routine run
```

An agent with a sandbox gets three tools:

- `computer.exec {command}` — run `sh -c` in the container (write-class: policy asks by default)
- `computer.read_file {path}` — `cat` a file (read-only)
- `computer.write_file {path, content}` — overwrite a file via a base64 round-trip (write-class)

`exec` output is capped at 64KB per stream and commands time out after 60s
(both configurable on `DockerRuntime`).

## Threat model (v1.0 — read before giving an agent a sandbox)

Every agent container is created with these flags (see `buildRunArgs()`
in `packages/sandbox/src/docker.ts` — the argv is unit-tested):

| Flag | Mitigates |
|---|---|
| `--cap-drop=ALL` | A compromised process cannot use privileged Linux capabilities (raw sockets, mounts, `ptrace`, …) |
| `--security-opt=no-new-privileges:true` | Binaries inside cannot gain privileges via setuid/setgid — blocks the classic container-escape primitive |
| `--memory=1g` / `--cpus=1.0` / `--pids-limit=256` | Fork bombs and runaway processes are contained; one agent cannot starve the host |
| `--tmpfs /tmp:rw,noexec,nosuid,size=256m` | Writable scratch space that cannot execute binaries or honor setuid |
| No `--privileged`, no host bind-mounts, default bridge network | The container has no host device access and no host filesystem visibility |

Tune the limits per agent: `new DockerRuntime({ memory: '2g', cpus: '2.0' })`,
or via env: `OMNI_SANDBOX_MEMORY`, `OMNI_SANDBOX_CPUS` (constructor opts win).

**What the flags do NOT mitigate (honest limits):**

1. **Kernel exploits.** A container-escape via a kernel vulnerability bypasses
   all of the above. Keep the host kernel patched; this is the same residual
   risk every Docker-based agent product (including the closed ones) carries.
2. **Side channels.** CPU/cache timing attacks across containers on shared
   hardware are out of scope.
3. **Malicious images.** Flags constrain *behavior*, not *content*. Pin image
   digests for anything serious: `OMNI_SANDBOX_IMAGE=ubuntu:24.04@sha256:…`.
4. **Egress.** Containers share the default Docker bridge network. There is no
   per-agent egress firewall yet — an agent with `computer.exec` can reach the
   internet. If that matters to you, run the host behind your own firewall
   rules or put the daemon on an isolated network.
5. **Trust zone.** The sandbox is a *single-agent* boundary: one agent per host
   trust zone. It is **not** a multi-tenant security boundary — do not run
   mutually untrusted agents' containers on the same host and expect isolation
   between them.

**The policy engine is still the primary control.** `computer.exec` and
`computer.write_file` are write-class tools: they default to `ask`, and an
explicit `deny` rule always wins. Defense in depth: policy decides *whether*
a command runs; the sandbox limits *what it can do* once allowed.

**Operational notes:**

- **No host mounts.** The container gets exactly one volume (`/home/agent`);
  the host filesystem is never mounted. Do not add `-v /…` flags.
- **Timeouts and output caps** (60s / 64KB per stream, configurable) bound a
  runaway command's blast radius.
- **Removing a container keeps the volume** (`DockerRuntime.remove` deletes
  the container only — the volume *is* the agent's disk). Prune explicitly:
  `docker volume rm omni-<id>-data`.
- **Secrets:** the sandbox never receives your env; pass only what the task
  needs, via tool arguments.

## Test honesty

**Docker is not installed on the machine this release was built on**
(`docker: command not found`), so no live containers were exercised here.
What *is* covered by tests: the exact `docker create` argv (all hardening
flags asserted in `packages/sandbox/test/docker-args.test.ts`), plus full
lifecycle/timeout/output-cap/tool-wiring behavior against `MockRuntime`.

**First-real-Docker-machine checklist** (run once, then delete this section's
doubt):

```sh
omni sandbox exec friday "echo ok"            # container comes up
omni sandbox exec friday "capsh --print" 2>/dev/null | head -3  # expect: no caps
docker inspect omni-friday --format '{{.HostConfig.Memory}}'    # expect: 1073741824
docker inspect omni-friday --format '{{.HostConfig.SecurityOpt}}' # expect: [no-new-privileges:true]
```

