resource "random_id" "artifact_suffix" {
  byte_length = 4
}

resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

locals {
  artifact_bucket_name = "${var.name}-artifacts-${random_id.artifact_suffix.hex}"
  api_origin_id        = "workshop-api"
  static_origin_id     = "workshop-static"
  static_files         = var.deploy_workshop ? fileset("${path.module}/../slides/dist", "**") : toset([])
  content_types = {
    html  = "text/html; charset=utf-8"
    css   = "text/css; charset=utf-8"
    js    = "text/javascript; charset=utf-8"
    mjs   = "text/javascript; charset=utf-8"
    json  = "application/json"
    svg   = "image/svg+xml"
    png   = "image/png"
    jpg   = "image/jpeg"
    jpeg  = "image/jpeg"
    webp  = "image/webp"
    ico   = "image/x-icon"
    woff  = "font/woff"
    woff2 = "font/woff2"
    ttf   = "font/ttf"
    wasm  = "application/wasm"
  }
}

# Private upload location for Lambda MicroVM image build ZIPs.
resource "aws_s3_bucket" "artifacts" {
  bucket        = local.artifact_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "microvm_build_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "microvm_build" {
  name               = "${var.name}-microvm-build"
  assume_role_policy = data.aws_iam_policy_document.microvm_build_trust.json
}

data "aws_iam_policy_document" "microvm_build" {
  statement {
    sid       = "ReadBuildArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/microvm/*"]
  }
  statement {
    sid       = "WriteBuildLogs"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "microvm_build" {
  name   = "${var.name}-microvm-build"
  role   = aws_iam_role.microvm_build.id
  policy = data.aws_iam_policy_document.microvm_build.json
}

resource "aws_cloudwatch_log_group" "microvm_build" {
  name              = "/aws/lambda-microvms/${var.name}"
  retention_in_days = 14
}

resource "random_id" "site_suffix" {
  count       = var.deploy_workshop ? 1 : 0
  byte_length = 4
}

resource "aws_s3_bucket" "site" {
  count         = var.deploy_workshop ? 1 : 0
  bucket        = "${var.name}-site-${random_id.site_suffix[0].hex}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "site" {
  count                   = var.deploy_workshop ? 1 : 0
  bucket                  = aws_s3_bucket.site[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  count  = var.deploy_workshop ? 1 : 0
  bucket = aws_s3_bucket.site[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "site" {
  count                             = var.deploy_workshop ? 1 : 0
  name                              = "${var.name}-site-oac"
  description                       = "CloudFront-only access to the private Slidev bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_dynamodb_table" "sessions" {
  count        = var.deploy_workshop ? 1 : 0
  name         = "${var.name}-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }
  server_side_encryption {
    enabled = true
  }
  point_in_time_recovery {
    enabled = false
  }
}

data "archive_file" "control" {
  count       = var.deploy_workshop ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/../control"
  output_path = "${path.module}/build/control.zip"
}

resource "aws_iam_role" "control" {
  count = var.deploy_workshop ? 1 : 0
  name  = "${var.name}-control"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = ["sts:AssumeRole"]
    }]
  })
}

data "aws_iam_policy_document" "control" {
  count = var.deploy_workshop ? 1 : 0
  statement {
    sid       = "ManageAttendeeSessions"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:TransactWriteItems"]
    resources = [aws_dynamodb_table.sessions[0].arn]
  }
  statement {
    sid       = "RunCurrentWorkshopImage"
    actions   = ["lambda:RunMicrovm"]
    resources = [var.microvm_image_arn]
  }
  statement {
    sid = "ManageExistingWorkshopMicroVMs"
    actions = [
      "lambda:GetMicrovm",
      "lambda:CreateMicrovmAuthToken",
      "lambda:TerminateMicrovm",
    ]
    # Existing sessions can outlive a deployment and continue using an older
    # workshop image. Keep their state checks and shell tokens working.
    resources = [
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:microvm-image:${var.name}-*"
    ]
  }
  statement {
    sid     = "PassManagedIngressConnector"
    actions = ["lambda:PassNetworkConnector"]
    # AWS does not support resource-level scoping for this permission-only action.
    resources = ["*"]
  }
  statement {
    sid     = "WriteLambdaLogs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.api[0].arn}:*",
      "${aws_cloudwatch_log_group.reaper[0].arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "control" {
  count  = var.deploy_workshop ? 1 : 0
  name   = "${var.name}-control"
  role   = aws_iam_role.control[0].id
  policy = data.aws_iam_policy_document.control[0].json
}

resource "aws_cloudwatch_log_group" "api" {
  count             = var.deploy_workshop ? 1 : 0
  name              = "/aws/lambda/${var.name}-api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "reaper" {
  count             = var.deploy_workshop ? 1 : 0
  name              = "/aws/lambda/${var.name}-reaper"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  count            = var.deploy_workshop ? 1 : 0
  function_name    = "${var.name}-api"
  role             = aws_iam_role.control[0].arn
  runtime          = "nodejs24.x"
  handler          = "aws-runtime.handler"
  filename         = data.archive_file.control[0].output_path
  source_code_hash = data.archive_file.control[0].output_base64sha256
  timeout          = 30
  memory_size      = 512
  architectures    = ["arm64"]

  environment {
    variables = {
      SESSION_TABLE       = aws_dynamodb_table.sessions[0].name
      MICROVM_IMAGE_ARN   = var.microvm_image_arn
      MAX_SESSIONS        = tostring(var.max_sessions)
      SESSION_TTL_SECONDS = tostring(var.session_ttl_seconds)
      ORIGIN_VERIFY_TOKEN = random_password.origin_verify.result
    }
  }

  depends_on = [aws_iam_role_policy.control, aws_cloudwatch_log_group.api]
}

resource "aws_lambda_function" "reaper" {
  count            = var.deploy_workshop ? 1 : 0
  function_name    = "${var.name}-reaper"
  role             = aws_iam_role.control[0].arn
  runtime          = "nodejs24.x"
  handler          = "reaper.handler"
  filename         = data.archive_file.control[0].output_path
  source_code_hash = data.archive_file.control[0].output_base64sha256
  timeout          = 60
  memory_size      = 256
  architectures    = ["arm64"]

  environment {
    variables = {
      SESSION_TABLE = aws_dynamodb_table.sessions[0].name
    }
  }
  depends_on = [aws_iam_role_policy.control, aws_cloudwatch_log_group.reaper]
}

resource "aws_apigatewayv2_api" "http" {
  count         = var.deploy_workshop ? 1 : 0
  name          = "${var.name}-api"
  protocol_type = "HTTP"
  description   = "Same-origin API for the Floci workshop"
}

resource "aws_apigatewayv2_integration" "api" {
  count                  = var.deploy_workshop ? 1 : 0
  api_id                 = aws_apigatewayv2_api.http[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api[0].invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "api" {
  count     = var.deploy_workshop ? 1 : 0
  api_id    = aws_apigatewayv2_api.http[0].id
  route_key = "ANY /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api[0].id}"
}

resource "aws_apigatewayv2_stage" "default" {
  count       = var.deploy_workshop ? 1 : 0
  api_id      = aws_apigatewayv2_api.http[0].id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}

resource "aws_lambda_permission" "api_gateway" {
  count         = var.deploy_workshop ? 1 : 0
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http[0].execution_arn}/*/*"
}

resource "aws_cloudfront_cache_policy" "api_disabled" {
  count       = var.deploy_workshop ? 1 : 0
  name        = "${var.name}-api-no-cache"
  comment     = "Do not cache attendee API calls or session cookies"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = false
    enable_accept_encoding_brotli = false
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_cache_policy" "static" {
  count       = var.deploy_workshop ? 1 : 0
  name        = "${var.name}-static-cache"
  comment     = "Cache content-hashed Slidev assets"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_origin_request_policy" "api" {
  count   = var.deploy_workshop ? 1 : 0
  name    = "${var.name}-api-origin-request"
  comment = "Forward attendee cookies, query strings, and headers except Host to API Gateway"
  cookies_config {
    cookie_behavior = "all"
  }
  headers_config {
    header_behavior = "allExcept"
    headers {
      items = ["Host"]
    }
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

# Slidev uses client-side routes such as /9, while the private S3 origin only
# contains index.html. Route those extensionless page URLs to the Slidev app.
resource "aws_cloudfront_function" "slidev_routes" {
  count   = var.deploy_workshop ? 1 : 0
  name    = "${var.name}-slidev-routes"
  runtime = "cloudfront-js-1.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
      if (lastSegment && lastSegment.indexOf('.') === -1) {
        request.uri = '/index.html';
      }
      return request;
    }
  JS
}

resource "aws_cloudfront_distribution" "site" {
  count               = var.deploy_workshop ? 1 : 0
  enabled             = true
  comment             = "${var.name} Slidev workshop"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  origin {
    origin_id                = local.static_origin_id
    domain_name              = aws_s3_bucket.site[0].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site[0].id
  }

  origin {
    origin_id   = local.api_origin_id
    domain_name = replace(aws_apigatewayv2_api.http[0].api_endpoint, "https://", "")
    origin_path = ""
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "X-Workshop-Origin"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id       = local.static_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = aws_cloudfront_cache_policy.static[0].id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.slidev_routes[0].arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = local.api_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = aws_cloudfront_cache_policy.api_disabled[0].id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
    # CloudFront forces TLSv1 when using its default *.cloudfront.net certificate.
    minimum_protocol_version = "TLSv1"
  }
}

resource "aws_s3_object" "site" {
  for_each      = local.static_files
  bucket        = aws_s3_bucket.site[0].id
  key           = each.value
  source        = "${path.module}/../slides/dist/${each.value}"
  source_hash   = filemd5("${path.module}/../slides/dist/${each.value}")
  content_type  = lookup(local.content_types, lower(reverse(split(".", each.value))[0]), "application/octet-stream")
  cache_control = each.value == "index.html" ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable"
}

data "aws_iam_policy_document" "site_read" {
  count = var.deploy_workshop ? 1 : 0
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site[0].arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site[0].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site_read" {
  count  = var.deploy_workshop ? 1 : 0
  bucket = aws_s3_bucket.site[0].id
  policy = data.aws_iam_policy_document.site_read[0].json
}

resource "aws_cloudwatch_event_rule" "reaper" {
  count               = var.deploy_workshop ? 1 : 0
  name                = "${var.name}-cleanup"
  description         = "Terminate expired Floci workshop MicroVM sessions"
  schedule_expression = "rate(2 minutes)"
}

resource "aws_cloudwatch_event_target" "reaper" {
  count     = var.deploy_workshop ? 1 : 0
  rule      = aws_cloudwatch_event_rule.reaper[0].name
  target_id = "${var.name}-reaper"
  arn       = aws_lambda_function.reaper[0].arn
}

resource "aws_lambda_permission" "eventbridge_reaper" {
  count         = var.deploy_workshop ? 1 : 0
  statement_id  = "AllowScheduledCleanup"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reaper[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reaper[0].arn
}
