-- CreateTable
CREATE TABLE "public"."RoomMetadata" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastWriteAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RoomMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomMetadata_lastWriteAt_idx" ON "public"."RoomMetadata"("lastWriteAt" DESC);
