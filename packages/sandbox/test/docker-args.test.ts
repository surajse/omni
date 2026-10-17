import { afterEach, describe, expect, it } from 'vitest';
import { DockerRuntime, buildRunArgs } from '../src/docker.js';

const OPTS = { volume: 'omni-test-data', image: 'ubuntu:24.04', memory: '1g', cpus: '1.0' };

describe('buildRunArgs hardening flags', () => {
  it('drops all capabilities and blocks privilege escalation', () => {
    const args = buildRunArgs('helper', OPTS);
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges:true');
  });

  it('applies resource limits', () => {
    const args = buildRunArgs('helper', OPTS);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--memory')).toBe('1g');
    expect(at('--cpus')).toBe('1.0');
    expect(at('--pids-limit')).toBe('256');
  });

  it('mounts a noexec tmpfs for /tmp and the agent volume', () => {
    const args = buildRunArgs('helper', OPTS);
    expect(args).toContain('/tmp:rw,noexec,nosuid,size=256m');
    expect(args).toContain('omni-test-data:/home/agent');
  });

  it('never grants host-level access', () => {
    const args = buildRunArgs('helper', OPTS);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--network=host');
    expect(args).not.toContain('--network');
    // No bind-mount of host paths: the only -v is the named agent volume.
    const mounts = args.filter((a, i) => args[i - 1] === '-v');
    expect(mounts).toEqual(['omni-test-data:/home/agent']);
  });

  it('sanitizes the agent id in the container name', () => {
    const args = buildRunArgs('My Agent!', OPTS);
    expect(args[args.indexOf('--name') + 1]).toBe('omni-my-agent');
  });

  it('keeps the agent running with sleep infinity', () => {
    const args = buildRunArgs('helper', OPTS);
    expect(args.slice(-3)).toEqual(['ubuntu:24.04', 'sleep', 'infinity']);
  });
});

describe('DockerRuntime resource configuration', () => {
  const savedMemory = process.env['OMNI_SANDBOX_MEMORY'];
  const savedCpus = process.env['OMNI_SANDBOX_CPUS'];
  afterEach(() => {
    if (savedMemory === undefined) delete process.env['OMNI_SANDBOX_MEMORY'];
    else process.env['OMNI_SANDBOX_MEMORY'] = savedMemory;
    if (savedCpus === undefined) delete process.env['OMNI_SANDBOX_CPUS'];
    else process.env['OMNI_SANDBOX_CPUS'] = savedCpus;
  });

  it('defaults to 1g memory and 1.0 cpus', () => {
    const rt = new DockerRuntime();
    expect(rt.memory).toBe('1g');
    expect(rt.cpus).toBe('1.0');
  });

  it('honors OMNI_SANDBOX_MEMORY and OMNI_SANDBOX_CPUS', () => {
    process.env['OMNI_SANDBOX_MEMORY'] = '512m';
    process.env['OMNI_SANDBOX_CPUS'] = '0.5';
    const rt = new DockerRuntime();
    expect(rt.memory).toBe('512m');
    expect(rt.cpus).toBe('0.5');
  });

  it('constructor options beat environment', () => {
    process.env['OMNI_SANDBOX_MEMORY'] = '512m';
    const rt = new DockerRuntime({ memory: '2g' });
    expect(rt.memory).toBe('2g');
  });
});
