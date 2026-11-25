export type RefusalCode = 'unsafe' | 'secrets' | 'other_account' | 'payment'
  | 'no_capability' | 'no_access' | 'future' | 'role' | 'human_step';

export type RefusalAlternative = 'protect' | 'private_output' | 'secure_entry' | 'sign_in'
  | 'own_account' | 'compare' | 'review_payment' | 'draft' | 'manual_step' | 'public_info'
  | 'plan' | 'forecast_sources' | 'ask_owner' | 'describe_image' | 'find_media' | 'share_material';

export interface RefusalDecision {
  readonly code: RefusalCode;
  readonly alternative: RefusalAlternative;
}
