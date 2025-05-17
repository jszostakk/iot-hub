from aws_cdk import (
    Stack,
    aws_lambda as _lambda,
    aws_apigateway as apigateway,
    aws_cognito as cognito,
    aws_s3 as s3,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_s3_deployment as s3deploy,
    aws_iam as iam,
    aws_ssm as ssm,
    Duration,
    CfnOutput,
    RemovalPolicy
)
from constructs import Construct

class InfraStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs):
        super().__init__(scope, construct_id, **kwargs)
        # ───────────── Hosting S3 Bucket ─────────────
        website_bucket = s3.Bucket(self, "FrontendWebsiteBucket",
            removal_policy=RemovalPolicy.DESTROY,
            bucket_name="iot-hub-frontend-cloudfront",
            auto_delete_objects=True,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL
        )

        # ───────────── OAC for CloudFront ─────────────
        oac = cloudfront.CfnOriginAccessControl(self, "OAC",
            origin_access_control_config=cloudfront.CfnOriginAccessControl.OriginAccessControlConfigProperty(
                name="OAC-iot-hub-Frontend",
                origin_access_control_origin_type="s3",
                signing_behavior="always",
                signing_protocol="sigv4"
            )
        )

        # ───────────── CloudFront Distribution ─────────────
        distribution = cloudfront.CfnDistribution(self, "WebsiteDistribution",
            distribution_config=cloudfront.CfnDistribution.DistributionConfigProperty(
                enabled=True,
                default_root_object="index.html",
                origins=[cloudfront.CfnDistribution.OriginProperty(
                    domain_name=website_bucket.bucket_regional_domain_name,
                    id="S3Origin",
                    s3_origin_config=cloudfront.CfnDistribution.S3OriginConfigProperty(
                        origin_access_identity=""
                    ),
                    origin_access_control_id=oac.ref
                )],
                default_cache_behavior=cloudfront.CfnDistribution.DefaultCacheBehaviorProperty(
                    target_origin_id="S3Origin",
                    viewer_protocol_policy="redirect-to-https",
                    allowed_methods=["GET", "HEAD", "OPTIONS"],
                    cached_methods=["GET", "HEAD"],
                    compress=True,
                    forwarded_values=cloudfront.CfnDistribution.ForwardedValuesProperty(
                        query_string=False,
                        cookies=cloudfront.CfnDistribution.CookiesProperty(forward="none")
                    )
                )
            )
        )

        # ───────────── Bucket Policy for CloudFront ─────────────
        website_bucket.add_to_resource_policy(iam.PolicyStatement(
            actions=["s3:GetObject"],
            resources=[website_bucket.arn_for_objects("*")],
            principals=[iam.ServicePrincipal("cloudfront.amazonaws.com")],
            conditions={
                "StringEquals": {
                    "AWS:SourceArn": f"arn:aws:cloudfront::{self.account}:distribution/{distribution.ref}"
                }
            }
        ))

        # ───────────── Upload React Build ─────────────
        s3deploy.BucketDeployment(self, "DeployFrontend",
            sources=[s3deploy.Source.asset("../frontend/iot-hub/build")],
            destination_bucket=website_bucket
        )

        # ───────────── Lambdas ─────────────
        set_led_lambda = _lambda.Function(
            self, "SetLedLambdaGo",
            runtime=_lambda.Runtime.PROVIDED_AL2,
            handler="bootstrap",
            code=_lambda.Code.from_asset("../backend/set_led_go"),
            environment={
                "MQTT_USERNAME_SSM": "/iot/mqtt/username",
                "MQTT_PASSWORD_SSM": "/iot/mqtt/password",
                "MQTT_BROKER_SSM":   "/iot/mqtt/broker",
            }
        )


        # process_tracker_lambda = _lambda.Function(
        #     self, "ProcessTrackerLambda",
        #     runtime=_lambda.Runtime.PYTHON_3_12,
        #     handler="lambda_function.handler",
        #     code=_lambda.Code.from_asset("../backend/process_tracker"),
        #     # memory_size=1024,
        #     # timeout=Duration.seconds(60)
        # )


        # ───────────── SSM Params ─────────────
        username_param = ssm.StringParameter.from_secure_string_parameter_attributes(
            self, "UsernameParam", parameter_name="/iot/mqtt/username", version=1,
        )
        password_param = ssm.StringParameter.from_secure_string_parameter_attributes(
            self, "PasswordParam", parameter_name="/iot/mqtt/password", version=1,
        )
        broker_param = ssm.StringParameter.from_string_parameter_attributes(
            self, "BrokerParam", parameter_name="/iot/mqtt/broker",
        )

        for param in [username_param, password_param, broker_param]:
            param.grant_read(set_led_lambda)

        
        # ───────────── REST API ─────────────
        api = apigateway.RestApi(self, "IoTHubAPI",
            rest_api_name="IoT Hub API",
            description="IoT Hub API",
            # binary_media_types=[
            #     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            # ],
            default_cors_preflight_options=apigateway.CorsOptions(
                allow_origins=apigateway.Cors.ALL_ORIGINS,
                allow_methods=apigateway.Cors.ALL_METHODS,
                allow_headers=apigateway.Cors.DEFAULT_HEADERS + ["Accept"]
            )
        )

        sl = api.root.add_resource("set-led")
        sl.add_method("POST", apigateway.LambdaIntegration(set_led_lambda))

        # pt = api.root.add_resource("process-tracker")
        # pt.add_method("POST", apigateway.LambdaIntegration(process_tracker_lambda))

        # ───────────── Cognito ─────────────
        user_pool = cognito.UserPool(self, "IoTHubUserPool",
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            account_recovery=cognito.AccountRecovery.EMAIL_ONLY,
            mfa=cognito.Mfa.REQUIRED,
            mfa_second_factor=cognito.MfaSecondFactor(
                sms=False,
                otp=True
            ),
            removal_policy=RemovalPolicy.DESTROY
        )


        user_pool_client = user_pool.add_client("IoTHubAppClient",
            auth_flows=cognito.AuthFlow(
                user_srp=True,
                user_password=True,
                admin_user_password=True
            )
        )

        # ───────────── Outputs ─────────────
        CfnOutput(self, "CloudFrontURL", value=f"https://{distribution.attr_domain_name}")
        CfnOutput(self, "ApiURL", value=api.url)
        CfnOutput(self, "UserPoolId", value=user_pool.user_pool_id)
        CfnOutput(self, "UserPoolClientId", value=user_pool_client.user_pool_client_id)