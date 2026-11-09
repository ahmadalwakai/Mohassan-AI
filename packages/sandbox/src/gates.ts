export const executableGateIds = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as const;
export type ExecutableGateId = typeof executableGateIds[number];
export interface ExecutableGate {
  id: ExecutableGateId;
  name: string;
  required: true;
  status: 'verified' | 'blocked';
  reason: string;
  evidence: string[];
}
export interface ExecutableReadiness {
  provider: 'windows-appcontainer';
  enabled: boolean;
  baselineVerified: boolean;
  gates: ExecutableGate[];
}

/** Evidence comes from the trusted runner, never from a skill manifest or stdout alone. */
export interface ExecutableGateEvidence {
  baselineVerified?: boolean;
  fixedUnpackagedHostVerified?: boolean;
  nativeUiRestrictionsVerified?: boolean;
  nodeRestrictionsVerified?: boolean;
  hardDiskQuotaVerified?: boolean;
  lowPrivilegeMarkerVerified?: boolean;
  lowPrivilegeTokenVerified?: boolean;
  publicResourceIsolationVerified?: boolean;
  fixedScriptVerified?: boolean;
  outputCollectionVerified?: boolean;
  sideChannelsVerified?: boolean;
}

/** A readiness report is diagnostic, not a caller-supplied execution permit. */
export function verifyExecutableGates(evidence: Readonly<ExecutableGateEvidence> = {}): ExecutableReadiness {
  const gate = (id: ExecutableGateId, name: string, verified: boolean, success: string, blocked: string, facts: string[] = []): ExecutableGate => ({
    id, name, required: true, status: verified ? 'verified' : 'blocked', reason: verified ? success : blocked, evidence: verified ? facts : [],
  });
  const gates: ExecutableGate[] = [
    gate('G1', 'Fixed unpackaged native host', evidence.fixedUnpackagedHostVerified === true,
      'The fixed System32 host produced verified AppContainer and Job evidence: zero capabilities, or only pinned registryRead under LPAC.',
      'The fixed unpackaged host has not produced verified native evidence.', ['GetCurrentPackageFullName', 'TokenIsAppContainer', 'TokenCapabilities=0 (LPAC: registryRead only)', 'Job limits queried before ResumeThread']),
    gate('G2', 'Hard disk quota', evidence.hardDiskQuotaVerified === true,
      'A trusted fixture filled a separate fixed-size volume and Windows stopped it with ENOSPC at the volume capacity.',
      'No per-run hard disk quota is proved. A size monitor or Job I/O notification is not a hard quota.', ['Native volume capacity read before ResumeThread', 'ENOSPC at the bound', 'Profile storage denied by the OS']),
    gate('G3', 'Windows UI restrictions', evidence.nativeUiRestrictionsVerified === true,
      'The trusted helper applied and queried JobObjectBasicUIRestrictions=0xff before ResumeThread.',
      'The native Job UI mask has not been verified by Windows.', ['SetInformationJobObject(4)', 'QueryInformationJobObject(4)=0xff; no interactive desktop manipulation performed']),
    gate('G4', 'Node permissions and native addons', evidence.nodeRestrictionsVerified === true,
      'A trusted isolated fixture verified filesystem allowlists and denial of child processes, workers and native addons.',
      'The Node permission and native-addon denial fixture has not passed.', ['--permission', '--no-addons', 'ERR_ACCESS_DENIED for source writes, outside reads, child processes and workers', 'ERR_DLOPEN_DISABLED']),
    gate('G5', 'LPAC and public-resource isolation', evidence.lowPrivilegeTokenVerified === true && evidence.publicResourceIsolationVerified === true,
      'The native LPAC token and controlled public-resource denial were independently verified.',
      evidence.lowPrivilegeTokenVerified ? 'LPAC token and Node compatibility verified; public-resource isolation is not yet proved.' : evidence.lowPrivilegeMarkerVerified ? 'The LPAC token marker is verified, but Node has not started under LPAC with only the pinned registryRead capability.' : 'LPAC is required; its native token and Node compatibility have not been proved.', ['Native WIN://NOALLAPPPKG token attribute', 'Exactly one enabled capability: pinned registryRead SID', 'Controlled public-resource denial']),
    gate('G6', 'Fixed script execution mode', evidence.fixedScriptVerified === true,
      'A repository-owned fixture ran through a fixed Node entry with bounded JSON inputs; public execution still requires every gate.',
      'The fixed script execution fixture has not passed.', ['Known snapshot entry', 'No caller shell, arguments or environment', 'Native requested memory cap matched']),
    gate('G7', 'Bounded output-file collection', evidence.outputCollectionVerified === true,
      'A trusted isolated fixture produced a bounded UTF-8 artifact collected after process exit with a hashed manifest.',
      'The isolated output collector fixture has not passed.', ['Canonical output root', 'No symlinks, junctions or hardlinks', '32 files, 128 entries, depth 8, at most 1 MiB raw and receipt']),
    gate('G8', 'UDP and named-pipe isolation', evidence.sideChannelsVerified === true,
      'Local receiver controls and OS-denied isolated UDP and named-pipe operations were verified.',
      'Controlled UDP and named-pipe isolation has not been proved. Timeouts and absent packets alone are insufficient.', ['Host nonce controls before and after', 'Isolated OS denial', 'No isolated receiver messages']),
  ];
  const baselineVerified = evidence.baselineVerified === true;
  return { provider: 'windows-appcontainer', enabled: baselineVerified && gates.every(entry => entry.status === 'verified'), baselineVerified, gates };
}
