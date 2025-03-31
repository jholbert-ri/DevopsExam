#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DevopsExamStack } from "../lib/devops_exam-stack";

const app = new cdk.App();
new DevopsExamStack(app, "DevopsExamStack", {
  env: {
    account: "559050209109",
    region: "sa-east-1",
  },
});
