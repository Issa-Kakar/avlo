import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../public')));
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', phase: 1 });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
