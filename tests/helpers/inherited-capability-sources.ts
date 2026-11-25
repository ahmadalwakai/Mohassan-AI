const mannersRevision = 'f50520112a23632ec4f6e4a121018077d1c422be';

// These exact files were accepted in wave 1 before the later guards ran.
// Each guard still compares its own occurrence counts with the pinned source.
export const inheritedCapabilitySourceRevisions: ReadonlyMap<string, string> = new Map([
  ['apps/server/src/assistant/manners/replies.ts', mannersRevision],
  ['tests/fixtures/manners-development.ts', mannersRevision],
]);
