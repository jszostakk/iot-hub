#!/bin/bash
set -e

echo "🛠️  Building Go Lambda..."

# Step 1: Build inside Docker (Amazon Linux 2–compatible)
sudo docker run --rm -v "$PWD":/go/src/app -w /go/src/app golang:1.21 \
  /bin/sh -c 'GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o bootstrap main.go'

# Step 2: Zip on host
echo "📦 Zipping..."
zip -q function.zip bootstrap

echo "✅ Done: function.zip is ready for CDK deployment"
