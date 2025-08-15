#!/bin/bash

# Development Environment Setup Script
# This ensures correct DATABASE_URL and Prisma client generation

set -e  # Exit on error

echo "🔧 Setting up Avlo development environment..."

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found! Creating from .env.example..."
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "📝 Created .env from .env.example"
        echo "⚠️  Please edit .env with your actual database credentials"
        exit 1
    else
        echo "❌ .env.example not found either!"
        exit 1
    fi
fi

# Load .env file
export $(cat .env | grep -v '^#' | xargs)

# Validate DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not found in .env file"
    exit 1
fi

if [[ "$DATABASE_URL" == *"user:password"* ]] || [[ "$DATABASE_URL" == *"username:password"* ]]; then
    echo "❌ DATABASE_URL contains placeholder values!"
    echo "Please edit .env file with actual database credentials"
    echo "Expected format: postgresql://[actual_username]:[actual_password]@host:port/database"
    exit 1
fi

echo "✅ DATABASE_URL validated"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Generate Prisma client with correct DATABASE_URL
echo "🔨 Generating Prisma client..."
cd server
npm run prisma:generate
cd ..

# Run database migrations
echo "🗄️ Running database migrations..."
npm run db:deploy

echo "✅ Development environment setup complete!"
echo ""
echo "You can now run: npm run dev"