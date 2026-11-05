import { createDatabase } from '@mohassan/database';
import { z } from 'zod';
import { createAuth, createOwner, migrateAuth } from './auth.js';
import { getConfig } from './config.js';
const config = getConfig();
if (!config.databaseUrl || config.authSecret.length < 32) throw new Error('اضبط DATABASE_URL وBETTER_AUTH_SECRET أولًا.');
const input = z.object({name:z.string().min(2),email:z.email(),password:z.string().min(12).max(128)}).parse({name:process.env.OWNER_NAME,email:process.env.OWNER_EMAIL,password:process.env.OWNER_PASSWORD});
const database = await createDatabase({connectionString: config.databaseUrl});
try {
  await migrateAuth(database.db);
  await createOwner(database.db, createAuth(database.db, {secret:config.authSecret,webOrigin:config.webOrigin,production:config.production}),input);
  console.log('تم إنشاء حساب المالك. يمكنك تسجيل الدخول.');
} finally {await database.close();}
