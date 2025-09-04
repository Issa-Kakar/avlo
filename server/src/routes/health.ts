// Stub for health routes - will be implemented in Phase 6B.6
import { Router } from 'express';

const router = Router();

router.get('/healthz', async (req, res) => {
  res.json({ 
    status: 'ok', 
    phase: 6,
    message: 'Health routes stub - full implementation pending Phase 6B.6'
  });
});

export { router as healthRoutes };