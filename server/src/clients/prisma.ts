import { PrismaClient } from '@prisma/client';

// Singleton instance
let prismaInstance: PrismaClient | null = null;

/**
 * Get or create Prisma client instance
 * This ensures we only create one instance and it uses the validated DATABASE_URL
 */
function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
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
    
    // Create Prisma client - it will use DATABASE_URL from environment
    prismaInstance = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn'] : ['error'],
    });
    
    // Log successful initialization (only in development)
    if (process.env.NODE_ENV === 'development') {
      console.log('✓ Prisma client initialized successfully');
    }
  }
  
  return prismaInstance;
}

// Export a proxy that lazily initializes the client
export const prisma = new Proxy({} as PrismaClient, {
  get(_, prop) {
    const client = getPrismaClient();
    return Reflect.get(client, prop);
  },
});