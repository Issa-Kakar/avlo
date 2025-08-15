-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastWriteAt" TIMESTAMP(3) NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);
