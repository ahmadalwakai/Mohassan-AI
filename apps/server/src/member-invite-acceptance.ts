import { sql, type Kysely } from 'kysely';
import { withAuthDatabaseTransaction, type createAuth } from './auth.js';
import { discardUnusedSignupSession } from './member-sessions.js';

const conflict = (code: string, message: string) => Object.assign(new Error(message), { statusCode: 409, code });

export async function acceptMemberInvite(
  db: Kysely<any>, auth: ReturnType<typeof createAuth>, invite: { id: string; email: string },
  input: { name: string; password: string },
) {
  await db.transaction().execute(async tx => {
    // Keep the claim, signup, membership and invite audit in one commit.
    const claimed = await tx.updateTable('workspace_invites').set({ claimed_at: sql`clock_timestamp()` })
      .where('id', '=', invite.id).where('claimed_at', 'is', null).where('revoked_at', 'is', null)
      .where('expires_at', '>', sql`clock_timestamp()`).executeTakeFirst();
    if (!Number(claimed.numUpdatedRows)) throw conflict('INVITE_IN_USE', 'تُستخدم هذه الدعوة الآن.');

    const { user, token } = await withAuthDatabaseTransaction(auth, tx, () =>
      auth.api.signUpEmail({ body: { email: invite.email, name: input.name, password: input.password } }),
    ).catch((error: { statusCode?: number; status?: string }) => {
      if (error.statusCode === 422 || error.status === 'UNPROCESSABLE_ENTITY') {
        throw conflict('MEMBER_EXISTS', 'يوجد حساب بهذا البريد بالفعل.');
      }
      throw error;
    });

    await discardUnusedSignupSession(tx, user.id, token);
    await tx.updateTable('workspace_invites').set({ consumed_by: user.id }).where('id', '=', invite.id).execute();
    await tx.insertInto('workspace_members').values({ user_id: user.id, role: 'member', invite_id: invite.id }).execute();
  });
}
