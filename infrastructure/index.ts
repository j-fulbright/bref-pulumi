import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import {WebApp, ConsoleApp, LambdaRole, S3BucketPolicy} from "./constructs";
import {SqsWorker} from "./constructs/SqsWorker";
import {SimpleVpc} from "./vpc/SimpleVpc";
import {AuroraSecurityGroup} from "./vpc/AuroraSecurityGroup";
import {AuroraServerless} from "./constructs/AuroraServerless";
import {VpcPolicy} from "./constructs/VpcPolicy";
import {readFileSync} from "fs";

// Create a new config object
const config = new pulumi.Config();

// Define the variables for the stack
let auroraCluster: AuroraServerless | null = null;
let credentials: any = null;
let securityGroup: AuroraSecurityGroup | null = null;
let lambdaVpcConfig: pulumi.Output<{ subnetIds: string[], securityGroupIds: string[] }> = pulumi.Output.create({
    subnetIds: [],
    securityGroupIds: []
});

// Create a VPC if required
let vpc: SimpleVpc | null = null;
if (config.getBoolean("useMySQL") || config.getBoolean("useVPC")) {
    // Create a VPC
    vpc = new SimpleVpc(
        "lambda-test-vpc",
        true,
        true,
        true,
        2,
        "10.0.0.0/16");
}

if (config.getBoolean("useMySQL") && vpc) {
    // Create the aurora security group
    securityGroup = new AuroraSecurityGroup(
        "lambda-test-aurora-security-group", vpc);

    // Extract the VPC configuration for lambda
    lambdaVpcConfig = pulumi.all([vpc.vpc.publicSubnetIds, securityGroup.securityGroup.id]).apply(([subnetIds, securityGroupId]) => ({
        subnetIds: subnetIds,
        securityGroupIds: [securityGroupId],
    }))

    // Create an Aurora Serverless v2 cluster
    auroraCluster = new AuroraServerless(
        "laravel-test-aurora", vpc, securityGroup);

    const auroraSecret = auroraCluster.secretArn.apply(secretArn =>
        aws.secretsmanager.getSecretVersion({
            secretId: secretArn,
        })
    );

    // Extract the username and password from the secret's JSON value
    credentials = auroraSecret.apply(secret => {
        if (!secret.secretString) {
            throw new Error("Secret string is empty");
        }
        const secretJson = JSON.parse(secret.secretString);
        return {
            username: secretJson.username,
            password: secretJson.password,
        };
    });
}

// Create an AWS resource (S3 Bucket)
const bucket = new aws.s3.Bucket("bref-example-bucket");

// Create the Lambda Role
const lambdaRole = new LambdaRole("lambdaRole");
lambdaRole.addPolicy("s3", new S3BucketPolicy(bucket).bucketPolicy);
lambdaRole.addPolicy("vpc", new VpcPolicy().vpcPolicy);

// Setup environment variables
const environment = {
    FILESYSTEM_DISK: "s3",
    AWS_BUCKET: bucket.bucket,
    DB_DATABASE: "laravelTest",
    DB_CONNECTION: "mysql",
    DB_HOST: auroraCluster ? auroraCluster.endpoint : "",
    DB_PORT: "3306",
    DB_USERNAME: credentials ? credentials.username : "",
    DB_PASSWORD: credentials ? credentials.password : "",
};

// Create the WebApp
const webApp = lambdaVpcConfig.apply(vpcConfig => new WebApp(
    "laravel-test",
    new pulumi.asset.FileArchive("../laravel"),
    lambdaRole,
    {BREF_LOOP_MAX: 250, ...environment},
    config.getBoolean("useOctane"),
    vpcConfig.subnetIds,
    vpcConfig.securityGroupIds
));

// Create the artisan app
const consoleApp = lambdaVpcConfig.apply(vpcConfig => new ConsoleApp(
    "laravel-test-artisan",
    new pulumi.asset.FileArchive("../laravel"),
    lambdaRole,
    environment,
    vpcConfig.subnetIds,
    vpcConfig.securityGroupIds
));

// Create the SQS Worker
const sqsWorker = lambdaVpcConfig.apply(vpcConfig => new SqsWorker(
    "laravel-test-worker",
    new pulumi.asset.FileArchive("../laravel"),
    lambdaRole,
    environment,
    vpcConfig.subnetIds,
    vpcConfig.securityGroupIds
));

// Enable the API Warmer
if (config.getBoolean("useApiWarmer")) {
    const apiWarmRate = config.get('apiWarmRate') || 'rate(5 minutes)';

    // Create the eventbridge rule
    const apiWarmScheduler = new aws.cloudwatch.EventRule(`api-warmer-${stackName}`, {
        description: 'Schedule for keeping api warm',
        scheduleExpression: apiWarmRate,
    });

    // Create the target for the api warmer
    const artisanSchedulerTarget = new aws.cloudwatch.EventTarget(`api-warmer-target-${stackName}`, {
        rule: apiWarmScheduler.name,
        arn: webApp.phpFunction.lambda.arn,
        input: JSON.stringify({
            warmer: true,
        }),
    });

    // Give permission to Eventbridge to invoke the lambda
    const apiWarmSchedulerPermission = new aws.lambda.Permission(`api-warmer-permission-${stackName}`, {
        action: 'lambda:InvokeFunction',
        function: webApp.phpFunction.lambda.name,
        principal: 'events.amazonaws.com',
        sourceArn: apiWarmScheduler.arn,
    });
}

if (config.getBoolean("useArtisanScheduler")) {
    const scheduleRate = config.get('artisanScheduleRate') || 'rate(1 minute)';

    // Create the eventbridge rule
    const artisanScheduler = new aws.cloudwatch.EventRule(`artisan-scheduler-${stackName}`, {
        description: 'Schedule for running artisan commands',
        scheduleExpression: scheduleRate,
    });

    // Create the target for the artisan scheduler
    const artisanSchedulerTarget = new aws.cloudwatch.EventTarget(`artisan-scheduler-target-${stackName}`, {
        rule: artisanScheduler.name,
        arn: consoleApp.phpFpmFunction.lambda.arn,
        input: '"schedule:run"',
    });

    // Give permission to Eventbridge to invoke the lambda
    const artisanSchedulerPermission = new aws.lambda.Permission(`artisan-scheduler-permission-${stackName}`, {
        action: 'lambda:InvokeFunction',
        function: consoleApp.phpFpmFunction.lambda.name,
        principal: 'events.amazonaws.com',
        sourceArn: artisanScheduler.arn,
    });
}


// Export the URL of the API Gateway
export const apiUrl = pulumi.interpolate`${webApp.httpApi.apiUrl}`;
// Export the name of the bucket
export const bucketName = bucket.id;
// Export the Lambda function name
export const lambdaName = webApp.phpFunction.lambda.name;
// Export the Lambda Policy ARN
export const lambdaRoleArn = lambdaRole.lambdaRole.arn;
// Export console Lambda function name
export const consoleLambdaName = consoleApp.phpFpmFunction.lambda.name;
// Export worker Lambda function name
export const workerLambdaName = sqsWorker.phpFunction.lambda.name;
// Export the queue URL
export const queueUrl = sqsWorker.queue.url;
// Export octane flag
export const useOctane = webApp.useOctane;
export const vpcId = vpc?.vpc.vpcId ?? "";
export const auroraClusterId = auroraCluster?.auroraCluster.id ?? "";
export const auroraClusterEndpoint = auroraCluster?.endpoint ?? "";
export const readme = readFileSync("./Pulumi.README.md").toString();
