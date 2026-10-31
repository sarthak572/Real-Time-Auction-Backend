import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';

export async function userRoutes(app: FastifyInstance) {
  app.post('/users', async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
    const { rows } = await pool.query('INSERT INTO users(name) VALUES($1) RETURNING id, name', [name]);
    req.log.info({ event: 'user.created', userId: rows[0].id }, 'user created');
    return reply.code(201).send(rows[0]);
  });
}
