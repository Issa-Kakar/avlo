// Stub for room routes - will be implemented in Phase 6B.6
import { Router } from 'express';

const router = Router();

// Placeholder route
router.get('/test', (req, res) => {
  res.json({ message: 'Room routes stub - implementation pending Phase 6B.6' });
});

export { router as roomRoutes };