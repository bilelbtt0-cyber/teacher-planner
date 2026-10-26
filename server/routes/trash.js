import { Router } from 'express';
import { listTrash, restoreFromTrash, deleteFromTrash, emptyTrash, TRASH_DAYS } from '../trash.js';

export const trashRouter = Router();

trashRouter.get('/', async (req, res) => {
  res.json({ days: TRASH_DAYS, items: await listTrash() });
});

trashRouter.post('/:id/restore', async (req, res) => {
  res.json(await restoreFromTrash(parseInt(req.params.id, 10)));
});

trashRouter.delete('/:id', async (req, res) => {
  await deleteFromTrash(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

trashRouter.delete('/', async (req, res) => {
  await emptyTrash();
  res.json({ ok: true });
});
