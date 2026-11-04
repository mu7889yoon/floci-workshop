variable "aws_region" {
  description = "AWS region for the control plane and MicroVM image. Lambda MicroVMs must be available here."
  type        = string
  default     = "ap-northeast-1"
}

variable "name" {
  description = "Prefix for workshop resources."
  type        = string
  default     = "floci-workshop"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,39}$", var.name))
    error_message = "name must be 3-40 lowercase letters, numbers, or hyphens and start with a letter."
  }
}

variable "deploy_workshop" {
  description = "Set false only for the initial image-builder bootstrap. Set true after the MicroVM image is created."
  type        = bool
  default     = false
}

variable "microvm_image_arn" {
  description = "Created Lambda MicroVM image ARN. Required when deploy_workshop is true."
  type        = string
  default     = ""
  validation {
    condition = !var.deploy_workshop || can(regex(
      "^arn:aws(-[a-z]+)?:lambda:[a-z0-9-]+:[0-9]{12}:microvm-image:.+$",
      var.microvm_image_arn
    ))
    error_message = "Set microvm_image_arn to a Lambda MicroVM image ARN before deploying the workshop."
  }
}

variable "max_sessions" {
  description = "Maximum number of simultaneous attendee MicroVMs."
  type        = number
  default     = 30
  validation {
    condition     = var.max_sessions >= 1 && var.max_sessions <= 100
    error_message = "max_sessions must be between 1 and 100."
  }
}

variable "session_ttl_seconds" {
  description = "Maximum attendee session lifetime; MicroVMs are terminated by the scheduled reaper."
  type        = number
  default     = 3600
  validation {
    condition     = var.session_ttl_seconds >= 600 && var.session_ttl_seconds <= 28800
    error_message = "session_ttl_seconds must be between 600 and 28800."
  }
}
