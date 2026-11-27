import type { AsyncLocalStorage } from 'node:async_hooks';
import { APIError, signInEmail } from 'better-auth/api';
import type { Kysely, Transaction } from 'kysely';

export function serializeMemberEmailSignIn(db: Kysely<any>, transaction: AsyncLocalStorage<Transaction<any>>) {
  const endpoint = signInEmail();
  // Better Auth dispatches a plugin endpoint with this key in place of the built-in endpoint.
  // Wrap the existing endpoint so HTTP rate limiting runs before the identity transaction.
  // https://registry.npmjs.org/better-auth/-/better-auth-1.7.17.tgz (retrieved 2026-11-27)
  return {
    id: 'serialized-email-sign-in',
    endpoints: {
      signInEmail: new Proxy(endpoint, {
        async apply(target, thisArg, args) {
          const input = args[0] as Parameters<typeof endpoint>[0];
          const email = input?.body?.email;
          const signIn = () => Reflect.apply(target, thisArg, args);
          if (typeof email !== 'string') return signIn();

          return db.transaction().execute(async tx => {
            // A reset or change takes an exclusive lock on the same row before replacing the credential.
            const user = await tx.selectFrom('user').select('id').where('email', '=', email.toLowerCase())
              .forKeyShare().executeTakeFirst();
            const result = await transaction.run(tx, signIn);
            if (!user) {
              // A concurrent invite acceptance may have created the identity after the lock query.
              throw APIError.from('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
            }
            return result;
          });
        },
      }),
    },
  };
}
