import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { S3NoAclFileService } from "./service"

export default ModuleProvider(Modules.FILE, {
  services: [S3NoAclFileService],
})
