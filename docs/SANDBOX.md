# Omni Sandbox (v0.2)

Each agent can get **its own computer**: one Docker container plus one
persistent volume.

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

## Security notes (read before giving an agent a sandbox)

1. **No host mounts.** The container gets exactly one volume (`/home/agent`);
   the host filesystem is never mounted. Do not add `-v /…` flags.
2. **Image pinning.** `OMNI_SANDBOX_IMAGE` defaults to `ubuntu:24.04`. Pin a
   digest (`ubuntu:24.04@sha256:…`) for reproducible, auditable sandboxes.
3. **Timeouts and output caps** bound a runaway command's blast radius, but
   they are not a security boundary — the policy engine (`allow/ask/deny`)
   is. Keep `computer.exec` on `ask` for agents you don't fully trust.
4. **No network policy yet.** Containers currently share the default Docker
   network. Restricting egress per agent is a v0.3 hardening item.
5. **Removing a container keeps the volume** (`DockerRuntime.remove` deletes
   the container only). Prune volumes explicitly: `docker volume rm omni-<id>-data`.
6. Secrets: the sandbox never receives your env; pass only what the task
   needs, via tool arguments.

## Test honesty

**Docker is not installed on the machine this release was built on**
(`docker: command not found`), so no live containers were exercised here.
All sandbox behavior is covered by tests against `MockRuntime` (lifecycle,
timeout, output caps, tool wiring). Live-container verification is expected
on the first machine with Docker — run `omni sandbox exec <id> "echo ok"`.
