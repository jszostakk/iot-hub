package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"os"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/ssm"
)

type RequestBody struct {
	Topic   string `json:"topic"`
	Message string `json:"message"`
}

func handler(ctx context.Context, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	// Initialize SSM client
	sess := session.Must(session.NewSession())
	ssmClient := ssm.New(sess)

	// Helper to read a parameter
	getParam := func(name string) string {
		param, err := ssmClient.GetParameter(&ssm.GetParameterInput{
			Name:           &name,
			WithDecryption: awsBool(true),
		})
		if err != nil {
			panic(err)
		}
		return *param.Parameter.Value
	}

	// Parse JSON request body
	var body RequestBody
	if request.Body != "" {
		if err := json.Unmarshal([]byte(request.Body), &body); err != nil {
			return errorResp("Invalid JSON body"), nil
		}
	}

	topic := body.Topic
	message := body.Message

	if topic == "" || message == "" {
		return errorResp("Missing 'topic' or 'message' in request body"), nil
	}

	// Fetch credentials and broker
	username := getParam(os.Getenv("MQTT_USERNAME_SSM") + ":1")
	password := getParam(os.Getenv("MQTT_PASSWORD_SSM") + ":1")
	broker := getParam(os.Getenv("MQTT_BROKER_SSM"))
	port := "8883"

	// Configure MQTT
	opts := mqtt.NewClientOptions().
		AddBroker(fmt.Sprintf("tls://%s:%s", broker, port)).
		SetUsername(username).
		SetPassword(password).
		SetTLSConfig(&tls.Config{InsecureSkipVerify: false})

	client := mqtt.NewClient(opts)

	if token := client.Connect(); token.Wait() && token.Error() != nil {
		return errorResp("MQTT connect failed: " + token.Error().Error()), nil
	}
	defer client.Disconnect(100)

	token := client.Publish(topic, 1, false, message)
	token.WaitTimeout(3 * time.Second)
	if token.Error() != nil {
		return errorResp("Publish failed: " + token.Error().Error()), nil
	}

	// Success response
	resp := map[string]interface{}{
		"published": map[string]string{
			"topic":   topic,
			"message": message,
		},
	}
	jsonResp, _ := json.Marshal(resp)

	return events.APIGatewayProxyResponse{
		StatusCode: 200,
		Headers: map[string]string{
			"Access-Control-Allow-Origin": "*",
			"Content-Type":                "application/json",
		},
		Body: string(jsonResp),
	}, nil
}

func awsBool(b bool) *bool {
	return &b
}

func errorResp(msg string) events.APIGatewayProxyResponse {
	return events.APIGatewayProxyResponse{
		StatusCode: 500,
		Body:       fmt.Sprintf(`{"error":"%s"}`, msg),
		Headers: map[string]string{
			"Access-Control-Allow-Origin": "*",
			"Content-Type":                "application/json",
		},
	}
}

func main() {
	lambda.Start(handler)
}
