import { z } from 'zod';

export const UuidSchema = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, { message: 'Invalid UUID format' });

// 1. Upload Job Request Payload Schema
export const UploadJobSchema = z.object({
  sizeBytes: z.coerce.number().int().positive({ message: 'sizeBytes must be a positive integer' }),
  idempotencyKey: z.string().min(1).max(255).optional(),
  expectedMd5: z.string().length(32, { message: 'expectedMd5 must be a valid 32-character hex string' }).optional(),
});

// 2. Migration Job Request Payload Schema
export const MigrationJobSchema = z.object({
  fileId: UuidSchema,
  destinationAccountId: UuidSchema,
  idempotencyKey: z.string().min(1).max(255).optional(),
});

// 3. Delete Job Request Payload Schema
export const DeleteJobSchema = z.object({
  fileId: UuidSchema,
  idempotencyKey: z.string().min(1).max(255).optional(),
});

// 4. Archive Job Request Payload Schema
export const ArchiveJobSchema = z.object({
  fileIds: z.array(UuidSchema).min(1, { message: 'At least one fileId is required for archiving' }),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

// 5. Virtual Folder Creation Schema
export const CreateFolderSchema = z.object({
  name: z.string().min(1, { message: 'Folder name cannot be empty' }).max(255),
  parentFolderId: UuidSchema.optional().nullable(),
});

// 6. Share Link Creation Schema
export const ShareLinkSchema = z.object({
  fileId: UuidSchema,
  password: z.string().max(100).optional().nullable(),
  expiresInHours: z.number().positive().max(8760).optional().nullable(),
});

// 7. Batch File Operation Schema
export const BatchOperationSchema = z.object({
  action: z.enum(['delete', 'move', 'archive'], { message: "action must be 'delete', 'move', or 'archive'" }),
  fileIds: z.array(UuidSchema).min(1, { message: 'At least one fileId is required' }),
  targetFolderId: UuidSchema.optional().nullable(),
});

export type UploadJobInput = z.infer<typeof UploadJobSchema>;
export type MigrationJobInput = z.infer<typeof MigrationJobSchema>;
export type DeleteJobInput = z.infer<typeof DeleteJobSchema>;
export type ArchiveJobInput = z.infer<typeof ArchiveJobSchema>;
export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;
export type ShareLinkInput = z.infer<typeof ShareLinkSchema>;
export type BatchOperationInput = z.infer<typeof BatchOperationSchema>;
