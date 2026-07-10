import { S3FileService } from "@medusajs/file-s3/dist/services/s3-file"
import { FileTypes } from "@medusajs/framework/types"
import { PutObjectCommand } from "@aws-sdk/client-s3"
import path from "path"
import { ulid } from "ulid"

/**
 * Extends S3FileService but strips the hardcoded ACL from uploads.
 * The bucket uses "Bucket owner enforced" (ACLs disabled) and relies
 * on a bucket policy for public read instead.
 */
export class S3NoAclFileService extends S3FileService {
  static identifier = "s3"

  async upload(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
    if (!file) throw new Error("No file provided")
    if (!file.filename) throw new Error("No filename provided")

    const parsedFilename = path.parse(file.filename)
    const prefix = this.config_.prefix ?? ""
    const fileKey = `${prefix}${parsedFilename.name}-${ulid()}${parsedFilename.ext}`

    let content: Buffer
    try {
      const decoded = Buffer.from(file.content as string, "base64")
      content = decoded.toString("base64") === file.content
        ? decoded
        : Buffer.from(file.content as string, "utf8")
    } catch {
      content = Buffer.from(file.content as string, "binary")
    }

    const command = new PutObjectCommand({
      Bucket: this.config_.bucket,
      Body: content,
      Key: fileKey,
      ContentType: file.mimeType,
      CacheControl: this.config_.cacheControl ?? "public, max-age=31536000",
      Metadata: { "original-filename": encodeURIComponent(file.filename) },
    })

    try {
      await this.client_.send(command)
    } catch (e) {
      this.logger_.error(e)
      throw e
    }

    return {
      url: `${this.config_.fileUrl}/${encodeURIComponent(fileKey)}`,
      key: fileKey,
    }
  }
}
