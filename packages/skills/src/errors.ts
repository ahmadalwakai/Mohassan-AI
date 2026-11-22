export class SkillError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = 'SkillError'; }
}

export type SkillPolicyReason = 'FINDINGS_NEED_ACK' | 'NOT_INSTRUCTION_ONLY' | 'HAS_SCRIPTS' | 'REQUESTS_ACCESS' | 'FOREIGN_SOURCE' | 'NOT_NEWER' | 'NOT_ACTIVATABLE';
/** An automatic activation policy was not met. The version simply waits for the owner's explicit decision. */
export class SkillPolicyError extends SkillError {
  constructor(public readonly reason: SkillPolicyReason, message: string) { super('SKILL_POLICY_NOT_MET', message, 409); this.name = 'SkillPolicyError'; }
}
