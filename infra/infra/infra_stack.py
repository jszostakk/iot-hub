from aws_cdk import (
    Stack,
    Duration,
    RemovalPolicy,
    aws_lambda as _lambda,
    aws_apigateway as apigateway,
    aws_cognito as cognito,
    aws_s3 as s3,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_s3_deployment as s3deploy,
    aws_iam as iam,
    aws_ssm as ssm,
    aws_iot as iot,
    aws_ssm as ssm,
    CfnOutput,
)
from constructs import Construct


class InfraStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs):
        super().__init__(scope, construct_id, **kwargs)

        # ───────────── Hosting S3 Bucket ─────────────
        website_bucket = s3.Bucket(
            self,
            "FrontendWebsiteBucket",
            bucket_name="iot-hub-frontend-cloudfront",
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
        )

        # ───────────── Origin Access Control (CloudFront ↔ S3) ─────────────
        oac = cloudfront.CfnOriginAccessControl(
            self,
            "OAC",
            origin_access_control_config=cloudfront.CfnOriginAccessControl.OriginAccessControlConfigProperty(
                name="OAC-iot-hub-Frontend",
                origin_access_control_origin_type="s3",
                signing_behavior="always",
                signing_protocol="sigv4",
            ),
        )

        # ───────────── CloudFront Distribution ─────────────
        distribution = cloudfront.CfnDistribution(
            self,
            "WebsiteDistribution",
            distribution_config=cloudfront.CfnDistribution.DistributionConfigProperty(
                enabled=True,
                default_root_object="index.html",
                origins=[
                    cloudfront.CfnDistribution.OriginProperty(
                        domain_name=website_bucket.bucket_regional_domain_name,
                        id="S3Origin",
                        s3_origin_config=cloudfront.CfnDistribution.S3OriginConfigProperty(
                            origin_access_identity=""
                        ),
                        origin_access_control_id=oac.ref,
                    )
                ],
                default_cache_behavior=cloudfront.CfnDistribution.DefaultCacheBehaviorProperty(
                    target_origin_id="S3Origin",
                    viewer_protocol_policy="redirect-to-https",
                    allowed_methods=["GET", "HEAD", "OPTIONS"],
                    cached_methods=["GET", "HEAD"],
                    compress=True,
                    forwarded_values=cloudfront.CfnDistribution.ForwardedValuesProperty(
                        query_string=False,
                        cookies=cloudfront.CfnDistribution.CookiesProperty(forward="none"),
                    ),
                ),
            ),
        )

        # ───────────── Bucket Policy (allow CloudFront) ─────────────
        website_bucket.add_to_resource_policy(
            iam.PolicyStatement(
                actions=["s3:GetObject"],
                resources=[website_bucket.arn_for_objects("*")],
                principals=[iam.ServicePrincipal("cloudfront.amazonaws.com")],
                conditions={
                    "StringEquals": {
                        "AWS:SourceArn": f"arn:aws:cloudfront::{self.account}:distribution/{distribution.ref}"
                    }
                },
            )
        )

        # ───────────── Upload React Build ─────────────
        s3deploy.BucketDeployment(
            self,
            "DeployFrontend",
            sources=[s3deploy.Source.asset("../frontend/iot-hub/build")],
            destination_bucket=website_bucket,
        )

        # ───────────── Lambda: set-led ─────────────
        set_led_lambda = _lambda.Function(
            self,
            "SetLedLambdaGo",
            runtime=_lambda.Runtime.PROVIDED_AL2,
            handler="bootstrap",
            code=_lambda.Code.from_asset("../backend/set_led_go"),
            environment={
                "MQTT_USERNAME_SSM": "/iot/mqtt/username",
                "MQTT_PASSWORD_SSM": "/iot/mqtt/password",
                "MQTT_BROKER_SSM": "/iot/mqtt/broker",
            },
        )

        # ───────────── SSM Params (readable by Lambda) ─────────────
        username_param = ssm.StringParameter.from_secure_string_parameter_attributes(
            self, "UsernameParam", parameter_name="/iot/mqtt/username", version=1
        )
        password_param = ssm.StringParameter.from_secure_string_parameter_attributes(
            self, "PasswordParam", parameter_name="/iot/mqtt/password", version=1
        )
        broker_param = ssm.StringParameter.from_string_parameter_attributes(
            self, "BrokerParam", parameter_name="/iot/mqtt/broker"
        )
        for param in (username_param, password_param, broker_param):
            param.grant_read(set_led_lambda)

        # ───────────── REST API ─────────────
        api = apigateway.RestApi(
            self,
            "IoTHubAPI",
            rest_api_name="IoT Hub API",
            description="IoT Hub API",
            default_cors_preflight_options=apigateway.CorsOptions(
                allow_origins=apigateway.Cors.ALL_ORIGINS,
                allow_methods=apigateway.Cors.ALL_METHODS,
                allow_headers=apigateway.Cors.DEFAULT_HEADERS + ["Accept", "Authorization"],
            ),
        )

        # ───────────── Cognito User Pool ─────────────
        user_pool = cognito.UserPool(
            self,
            "IoTHubUserPool",
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            account_recovery=cognito.AccountRecovery.EMAIL_ONLY,
            mfa=cognito.Mfa.REQUIRED,
            mfa_second_factor=cognito.MfaSecondFactor(sms=False, otp=True),
            removal_policy=RemovalPolicy.DESTROY,
        )

        user_pool_client = user_pool.add_client(
            "IoTHubAppClient",
            auth_flows=cognito.AuthFlow(
                user_srp=True,
                user_password=True,
                admin_user_password=True,
            ),

            # ─────── session = 60 minutes ───────
            id_token_validity     = Duration.hours(1),
            access_token_validity = Duration.hours(1),
            refresh_token_validity= Duration.hours(1),
            enable_token_revocation = True,
        )

        # ───────────── Cognito Authorizer ─────────────
        authorizer = apigateway.CognitoUserPoolsAuthorizer(
            self,
            "IoTHubAuthorizer",
            cognito_user_pools=[user_pool],  # secure with this user-pool
            identity_source="method.request.header.Authorization",
        )

        # ───────────── /set-led  (secured) ─────────────
        set_led_resource = api.root.add_resource("set-led")
        set_led_resource.add_method(
            "POST",
            apigateway.LambdaIntegration(set_led_lambda),
            authorizer=authorizer,
            authorization_type=apigateway.AuthorizationType.COGNITO,
        )

        thing = iot.CfnThing(self, "EspThing", thing_name="esp8266-001")

        iot_policy = iot.CfnPolicy(
            self, "EspPolicy",
            policy_name="EspPolicy",
            policy_document={
                "Version": "2012-10-17",
                "Statement": [
                    {
                    "Effect": "Allow",
                    "Action": "iot:Connect",
                    "Resource":
                    f"arn:aws:iot:{self.region}:{self.account}:client/${{iot:Connection.Thing.ThingName}}"
                    },
                    {  # subscribe & receive commands
                    "Effect": "Allow",
                    "Action": ["iot:Subscribe", "iot:Receive"],
                    "Resource":
                    f"arn:aws:iot:{self.region}:{self.account}:topicfilter/esp8266/commands/#"
                    }
                ]
            }
        )
        
        cert_arn = "arn:aws:iot:eu-central-1:362554412840:cert/a6a16362059843b24e67a99ec569ef8301005a7dcad0794376cb4561c53f72de"

        iot.CfnPolicyPrincipalAttachment(
            self, "AttachPol",
            policy_name=iot_policy.ref,
            principal=cert_arn
        )

        iot.CfnThingPrincipalAttachment(
            self, "AttachThing",
            thing_name=thing.ref,
            principal=cert_arn
        )             

        # ───────────── Outputs ─────────────
        CfnOutput(self, "CloudFrontURL", value=f"https://{distribution.attr_domain_name}")
        CfnOutput(self, "ApiURL", value=api.url)
        CfnOutput(self, "UserPoolId", value=user_pool.user_pool_id)
        CfnOutput(self, "UserPoolClientId", value=user_pool_client.user_pool_client_id)
