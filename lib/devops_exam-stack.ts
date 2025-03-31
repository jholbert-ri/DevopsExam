import * as cdk from "aws-cdk-lib";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2Targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class DevopsExamStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "MiVpc", {
      vpcName: "vpc-exam",
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "PublicSubnet",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "PrivateSubnet",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    const ubuntuAmi = ec2.MachineImage.genericLinux({
      [this.region]: "ami-0f399d0a437f76d31",
    });

    // ==============================================
    // BASTION SSH EC2
    // ==============================================
    const bastionSecurityGroup = new ec2.SecurityGroup(
      this,
      "BastionSecurityGroup",
      {
        vpc,
        securityGroupName: "bastion-sg",
        description: "Permite SSH desde la Lambda",
        allowAllOutbound: true,
      }
    );

    bastionSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Permitir SSH desde la Lambda"
    );

    new ec2.Instance(this, "SSH-EXAM-EC2", {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MEDIUM
      ),
      machineImage: ubuntuAmi,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: bastionSecurityGroup,
      keyName: "SSH-KEY-PAIRS-BETA-ODO",
    });

    // ==============================================
    // *** END BASTION SSH EC2 ***
    // ==============================================

    new s3.Bucket(this, "DeploymentBucket", {
      bucketName: `codedeploy-deployment-bucket-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const codeDeployServiceRole = new iam.Role(this, "CodeDeployServiceRole", {
      assumedBy: new iam.ServicePrincipal("codedeploy.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSCodeDeployRole"
        ),
      ],
    });

    const ec2CodeDeployRole = new iam.Role(this, "EC2CodeDeployRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3ReadOnlyAccess"),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "CloudWatchAgentServerPolicy"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLogsFullAccess"),
      ],
    });

    const securityGroup = new ec2.SecurityGroup(this, "Ec2SecurityGroup", {
      vpc,
      securityGroupName: "ec2-exam-sg",
      description: "Allow SSH Traffic to Mongo",
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Permitir SSH"
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP Connections"
    );

    securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(27017),
      "Permitir MongoDB"
    );

    const normalEc2 = new ec2.Instance(this, "Ec2Instance-Exam", {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.NANO
      ),
      machineImage: ubuntuAmi,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup,
      role: ec2CodeDeployRole,
      keyName: "SSH-KEY-PAIRS-BETA-ODO",
    });

    cdk.Tags.of(normalEc2).add("Name", "normal-ec2");

    // ==============================================
    // ALB y TargetGroup para la instancia "normalEc2"
    // ==============================================
    const ec2WithoutScaling = new elbv2.ApplicationLoadBalancer(
      this,
      "ec2WithoutScaling",
      {
        vpc,
        internetFacing: true,
        loadBalancerName: "alb-ec2WithoutScaling-app",
      }
    );

    const ec2WithoutScalingListener = ec2WithoutScaling.addListener(
      "ec2WithoutScalingListener",
      {
        port: 80,
        open: true,
      }
    );

    ec2WithoutScalingListener.addTargets("Ec2WithoutScalingTargetGroup", {
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new elbv2Targets.InstanceTarget(normalEc2, 3001)],
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        healthyHttpCodes: "200-399",
      },
    });

    normalEc2.connections.allowFrom(ec2WithoutScaling, ec2.Port.tcp(3001));

    const normalEc2App = new codedeploy.ServerApplication(
      this,
      "NormalEc2App",
      {
        applicationName: "normal-ec2-app",
      }
    );

    // 2. Deployment Group
    new codedeploy.ServerDeploymentGroup(this, "NormalEc2DeploymentGroup", {
      application: normalEc2App,
      deploymentGroupName: "normal-ec2-deployment-group",
      ec2InstanceTags: new codedeploy.InstanceTagSet({
        Name: ["normal-ec2"],
      }),

      role: codeDeployServiceRole,
      installAgent: false,
      deploymentConfig: codedeploy.ServerDeploymentConfig.ALL_AT_ONCE,
    });

    // ==============================================
    // EC2 WITH AUTOSCALING
    // ==============================================
    const cwUserData = ec2.UserData.custom(`#!/bin/bash
      # Actualiza e instala CloudWatch Agent
      apt-get update -y
      wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
      dpkg -i amazon-cloudwatch-agent.deb
      # Crear directorio de logs si no existe
      mkdir -p /home/ubuntu/app/logs

      # Crear archivo de configuración de CloudWatch Agent
      cat <<EOF > /opt/aws/amazon-cloudwatch-agent/bin/config.json
      {
        "logs": {
          "logs_collected": {
            "files": {
              "collect_list": [
                {
                  "file_path": "/home/ubuntu/app/logs/app-output.log",
                  "log_group_name": "/aws/ec2/mi-app-node",
                  "log_stream_name": "{instance_id}-output",
                  "timestamp_format": "%Y-%m-%d %H:%M:%S"
                },
                {
                  "file_path": "/home/ubuntu/app/logs/app-errors.log",
                  "log_group_name": "/aws/ec2/mi-app-node",
                  "log_stream_name": "{instance_id}-errors",
                  "timestamp_format": "%Y-%m-%d %H:%M:%S"
                }
              ]
            }
          }
        }
      }
      EOF

      # Iniciar el agente
      /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \\
        -a fetch-config \\
        -m ec2 \\
        -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json \\
        -s
      `);

    const launchTemplate = new ec2.LaunchTemplate(
      this,
      "EC2-WITH-AUTOSCALING",
      {
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T4G,
          ec2.InstanceSize.MEDIUM
        ),
        machineImage: ubuntuAmi,
        securityGroup,
        keyName: "SSH-KEY-PAIRS-BETA-ODO",
        role: ec2CodeDeployRole,
        userData: cwUserData,
      }
    );

    const autoScalingGroup = new autoscaling.AutoScalingGroup(
      this,
      "AutoScalingGroup",
      {
        vpc,
        launchTemplate,
        minCapacity: 1,
        maxCapacity: 4,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      }
    );

    autoScalingGroup.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 70,
    });

    const application = new codedeploy.ServerApplication(
      this,
      "CodeDeployApplication",
      {
        applicationName: "ec2-with-autoscaling",
      }
    );

    new codedeploy.ServerDeploymentGroup(this, "DeploymentGroup", {
      application,
      deploymentGroupName: "mi-app-node-deployment-group",
      autoScalingGroups: [autoScalingGroup],
      installAgent: false,
      role: codeDeployServiceRole,
      deploymentConfig: codedeploy.ServerDeploymentConfig.ALL_AT_ONCE,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      internetFacing: true,
      loadBalancerName: "alb-ec2-with-autoscaling",
    });

    const listener = alb.addListener("Listener", {
      port: 80,
      open: true,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [autoScalingGroup],
      healthCheck: {
        path: "/status",
        interval: cdk.Duration.seconds(30),
      },
    });

    listener.addTargetGroups("TargetGroup", {
      targetGroups: [targetGroup],
    });

    autoScalingGroup.connections.allowFrom(alb, ec2.Port.tcp(3001));

    // ==============================================
    // *** END EC2 WITH AUTOSCALING ***
    // ==============================================

    // ==============================================
    // EC2 WITH WSS
    // ==============================================
    const wssSecurityGroup = new ec2.SecurityGroup(this, "WssSecurityGroup", {
      vpc,
      securityGroupName: "wss-sg",
      description: "Permite trafico WebSocket y SSH",
      allowAllOutbound: true,
    });

    wssSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Permitir trafico WebSocket"
    );

    wssSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Permitir trafico SSH"
    );

    const wssLaunchTemplate = new ec2.LaunchTemplate(
      this,
      "WssLaunchTemplate",
      {
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T4G,
          ec2.InstanceSize.MEDIUM
        ),
        machineImage: ubuntuAmi,
        securityGroup: wssSecurityGroup,
        keyName: "SSH-KEY-PAIRS-BETA-ODO",
        role: ec2CodeDeployRole,
      }
    );

    const wssAutoScalingGroup = new autoscaling.AutoScalingGroup(
      this,
      "WssAutoScalingGroup",
      {
        vpc,
        launchTemplate: wssLaunchTemplate,
        minCapacity: 1,
        maxCapacity: 4,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      }
    );

    const wssAlb = new elbv2.ApplicationLoadBalancer(this, "WssALB", {
      vpc,
      internetFacing: true,
      loadBalancerName: "alb-wss-app",
    });

    const wssListener = wssAlb.addListener("WssListener", {
      port: 80,
      open: true,
    });

    const wssTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "WssTargetGroup",
      {
        vpc,
        port: 3001,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [wssAutoScalingGroup],
        healthCheck: {
          path: "/ws-health",
          interval: cdk.Duration.seconds(30),
          healthyHttpCodes: "200-399",
        },
        stickinessCookieDuration: cdk.Duration.hours(1),
        stickinessCookieName: "WSSessionCookie",
        deregistrationDelay: cdk.Duration.seconds(30),
      }
    );

    wssListener.addTargetGroups("WssTargetGroup", {
      targetGroups: [wssTargetGroup],
    });

    const wssApplication = new codedeploy.ServerApplication(
      this,
      "WssCodeDeployApplication",
      {
        applicationName: "wss-node-app",
      }
    );

    new codedeploy.ServerDeploymentGroup(this, "WssDeploymentGroup", {
      application: wssApplication,
      deploymentGroupName: "wss-node-deployment-group",
      autoScalingGroups: [wssAutoScalingGroup],
      installAgent: false,
      role: codeDeployServiceRole,
      deploymentConfig: codedeploy.ServerDeploymentConfig.ALL_AT_ONCE,
    });

    // ==============================================
    // Configuraciones adicionales
    // ==============================================

    wssAutoScalingGroup.connections.allowFrom(wssAlb, ec2.Port.tcp(3001));

    wssSecurityGroup.addIngressRule(
      securityGroup,
      ec2.Port.tcp(22),
      "Permitir SSH desde el bastion"
    );
  }
}
