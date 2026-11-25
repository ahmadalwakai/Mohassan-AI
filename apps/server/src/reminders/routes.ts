import {
  CreateReminderInputSchema,
  EditReminderInputSchema,
} from '@mohassan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { reminderPaths } from './route-keys.js';
import type { createReminderStore } from './storage.js';
import { parseReminderTime } from './time.js';

const { base, due, item } = reminderPaths;

const Empty = z.object({}).strict();
const Params = z.object({ id: z.uuid() }).strict();
const timeError = (code: string, message: string) => Object.assign(new Error(message), { statusCode: 400, code });

function resolveEditTime(localDueAt: string, timeZone: string, disambiguation?: 'earlier' | 'later'): string {
  const result = parseReminderTime(localDueAt, { now: new Date(), timeZone, disambiguation });
  if (result.kind === 'parsed') return result.dueAt.toISOString();
  switch (result.reason) {
    case 'dst_overlap':
      throw timeError('REMINDER_TIME_AMBIGUOUS', 'هذا الوقت يتكرر عند تغيير الساعة. اختر الموعد الأول أو الثاني.');
    case 'dst_gap':
      throw timeError('REMINDER_TIME_GAP', 'هذا الوقت غير موجود في هذه المنطقة عند تغيير الساعة. اختر وقتًا آخر.');
    case 'past':
      throw timeError('REMINDER_TIME_IN_PAST', 'اختر وقتًا في المستقبل.');
    default:
      throw timeError('REMINDER_TIME_INVALID', 'تحقق من التاريخ والوقت.');
  }
}

interface ReminderRouteOptions {
  owner: (request: FastifyRequest) => Promise<{ id: string }>;
  reminders: ReturnType<typeof createReminderStore>;
}

export function registerReminderRoutes(app: FastifyInstance, { owner, reminders }: ReminderRouteOptions) {
  app.get(base, async (request, reply) => {
    const user = await owner(request);
    Empty.parse(request.query);
    reply.header('cache-control', 'private, no-store');
    return { reminders: await reminders.list(user.id) };
  });

  app.get(due, async (request, reply) => {
    const user = await owner(request);
    Empty.parse(request.query);
    reply.header('cache-control', 'private, no-store');
    return { deliveries: await reminders.listDue(user.id) };
  });

  app.post(base, async (request, reply) => {
    const user = await owner(request);
    Empty.parse(request.query);
    const input = CreateReminderInputSchema.parse(request.body);
    const reminder = await reminders.create(user.id, input);
    return reply.code(201).send({ reminder });
  });

  app.patch(item, async (request) => {
    const user = await owner(request);
    Empty.parse(request.query);
    const { id } = Params.parse(request.params);
    const { localDueAt, overlap, expected, ...changes } = EditReminderInputSchema.parse(request.body);
    if (localDueAt && changes.timeZone) changes.dueAt = resolveEditTime(localDueAt, changes.timeZone, overlap);
    return { reminder: await reminders.update(user.id, id, changes, expected) };
  });

  app.delete(item, async (request) => {
    const user = await owner(request);
    Empty.parse(request.query);
    Empty.parse(request.body ?? {});
    const { id } = Params.parse(request.params);
    return { reminder: await reminders.cancel(user.id, id) };
  });
}
