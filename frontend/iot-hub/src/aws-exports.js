// src/aws-exports.js
const awsconfig = {
  aws_project_region:           "eu-central-1",
  aws_cognito_region:           "eu-central-1",
  aws_user_pools_id:            "eu-central-1_cuvXSEQ7t",
  aws_user_pools_web_client_id: "4lpkdidrd1j82sr5i6kpbifm5r",
  aws_cloud_logic_custom: [
    {
      name:     "IotHubAPI",
      endpoint: "https://q5fu9a4dz4.execute-api.eu-central-1.amazonaws.com/prod",
      region:   "eu-central-1"
    }
  ],
};
export default awsconfig;
