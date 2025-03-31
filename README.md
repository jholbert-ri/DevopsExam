# DevOps Exam Stack - Descripción del Entorno en AWS

Este proyecto define una infraestructura en AWS utilizando **AWS CDK con TypeScript**, orientado a simular un entorno real con diferentes tipos de despliegues sobre EC2, autoescalado, WebSockets y CodeDeploy.

---

## 🌐 VPC y Red

- VPC llamada `vpc-exam` con rango CIDR `10.0.0.0/16`
- 2 subredes por zona de disponibilidad:
  - `PublicSubnet`: subred pública /24
  - `PrivateSubnet`: subred privada con salida a internet /24

---

## 🚀 EC2 Instances

### 1. Bastion Host
- Instancia EC2 en subred pública
- Permite acceso SSH (✅ `port 22`) desde cualquier IP
- Uso: punto de acceso para otras instancias privadas

### 2. EC2 Individual (sin autoescalado)
- Instancia en subred privada
- Corre una app Node.js escuchando en el puerto `3001`
- Expuesta mediante un ALB (Application Load Balancer)
- Health check en `/health`
- Desplegada mediante AWS CodeDeploy
- Logs enviados a CloudWatch:
  - `/home/ubuntu/app/logs/app-output.log`
  - `/home/ubuntu/app/logs/app-errors.log`

### 3. EC2 con AutoScaling
- AutoScaling Group (ASG) en subred privada
- Launch Template con Ubuntu y userData configurado
- Expone app Node.js en el puerto `3001`
- ALB con health check en `/status`
- Escalado basado en CPU
- CodeDeploy DeploymentGroup vinculado al ASG
- Logs enviados a CloudWatch Logs con log streams por instancia:
  - Log group: `/aws/ec2/mi-app-node`

### 4. EC2 con AutoScaling para WebSocket
- ASG en subred pública
- App Node.js con WebSocket en puerto `3001`
- ALB con Sticky Sessions (cookie `WSSessionCookie`)
- Health check en `/ws-health`
- CodeDeploy DeploymentGroup para despliegue

---

## 🚨 Load Balancers

- `alb-ec2WithoutScaling-app`: para instancia sin autoescalado
- `alb-ec2-with-autoscaling`: para ASG sin WebSocket
- `alb-wss-app`: para instancias WebSocket

---

## 🚫 Seguridad (Security Groups)

- `bastion-sg`: acceso SSH desde cualquier origen
- `ec2-exam-sg`: acceso HTTP/SSH y MongoDB interno (puerto 27017)
- `wss-sg`: acceso HTTP y SSH desde internet, más acceso SSH desde bastion

---

## 💾 Bucket de Despliegue

- Bucket S3 creado automáticamente con `autoDeleteObjects: true`
- Nombre: `codedeploy-deployment-bucket-<account>-<region>`

---

## 📥 CodeDeploy

- 3 aplicaciones:
  - `normal-ec2-app`
  - `ec2-with-autoscaling`
  - `wss-node-app`
- Cada una con su `DeploymentGroup`
- Soporte para `appspec.yml` y PM2

---

## 📊 Monitoreo con CloudWatch

- CloudWatch Agent instalado vía `userData`
- Logs configurados con `config.json`
- Streams diferenciados por instancia
- Log group unificado: `/aws/ec2/mi-app-node`

---

## ✅ Requisitos cumplidos

- [x] EC2 bastion con acceso SSH
- [x] EC2 individual desplegada vía CodeDeploy
- [x] EC2 autoscaling con CodeDeploy + CloudWatch Logs
- [x] EC2 autoscaling para WebSockets con Sticky Sessions
- [x] 3 ALBs funcionando con Health Checks
- [x] PM2 ejecutando app Node.js con `ecosystem.config.js`


## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
