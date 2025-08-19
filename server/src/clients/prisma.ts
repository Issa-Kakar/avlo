import { PrismaClient } from '@prisma/client';

// Validate DATABASE_URL on import
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set. Check .env file.');
}

// Validate DATABASE_URL is not a placeholder
if (DATABASE_URL.includes('user:password') || DATABASE_URL.includes('username:password')) {
  throw new Error(
    'DATABASE_URL contains placeholder values. Please set correct credentials in .env file.\n' +
    'Expected format: postgresql://[actual_username]:[actual_password]@host:port/database'
  );
}

// Create singleton Prisma client with proper error handling
const prismaClientSingleton = () => {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    errorFormat: 'minimal',
  });
};

// Global type declaration for development
declare global {
  var prismaGlobal: undefined | ReturnType<typeof prismaClientSingleton>;
}

// Use global instance in development to prevent multiple instances during hot reload
export const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

if (process.env.NODE_ENV !== 'production') {
  globalThis.prismaGlobal = prisma;
}

// Connect immediately and handle errors
prisma.$connect()
  .then(() => {
    if (process.env.NODE_ENV === 'development') {
      console.log('✓ Prisma client connected to PostgreSQL');
    }
  })
  .catch((error) => {
    console.error('✗ Failed to connect to PostgreSQL:', error);
    // Don't exit the process, let the server continue with degraded mode
    console.warn('⚠ Server will continue in degraded mode (metadata endpoints may fail)');
  });

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});