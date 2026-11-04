output "microvm_artifact_bucket" {
  description = "Private S3 bucket used by Lambda MicroVM image builds."
  value       = aws_s3_bucket.artifacts.bucket
}

output "microvm_build_role_arn" {
  description = "Build role passed to lambda-microvms create-microvm-image."
  value       = aws_iam_role.microvm_build.arn
}

output "microvm_build_log_group" {
  description = "CloudWatch log group for MicroVM image build logs."
  value       = aws_cloudwatch_log_group.microvm_build.name
}

output "workshop_url" {
  description = "HTTPS URL for the deployed Slidev workshop."
  value       = var.deploy_workshop ? "https://${aws_cloudfront_distribution.site[0].domain_name}" : null
}

output "api_gateway_url" {
  description = "Internal API Gateway URL, routed through CloudFront for same-origin browser access."
  value       = var.deploy_workshop ? aws_apigatewayv2_api.http[0].api_endpoint : null
}

output "active_session_table" {
  description = "DynamoDB table holding attendee-to-MicroVM mappings."
  value       = var.deploy_workshop ? aws_dynamodb_table.sessions[0].name : null
}
