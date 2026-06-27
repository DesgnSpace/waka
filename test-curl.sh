#!/bin/bash

# Waka Email Testing with cURL
# Replace these variables with your actual values

API_KEY=""  # Get from Waka API Keys tab
FROM_EMAIL="info@waka.com"  # Your verified domain email
TO_EMAIL="your-email@example.com"  # Your email address
BASE_URL="http://localhost:3000"

echo "🚀 Testing Waka with cURL"
echo "================================"

# Test 1: Send a simple email
echo "📧 Sending test email..."

curl -X POST "$BASE_URL/api/emails" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"from\": \"$FROM_EMAIL\",
    \"to\": [\"$TO_EMAIL\"],
    \"subject\": \"🧪 Waka cURL Test\",
    \"html\": \"<h1>Success!</h1><p>This email was sent using <strong>Waka</strong> via cURL!</p><p>Your email setup is working! 🎉</p>\",
    \"text\": \"Success! This email was sent using Waka via cURL!\"
  }" | jq '.'

echo ""
echo "================================"

# Test 2: Check email logs
echo "📊 Checking recent email logs..."

curl -X GET "$BASE_URL/api/emails/logs?limit=3" \
  -H "Authorization: Bearer $API_KEY" | jq '.'

echo ""
echo "🎉 Testing complete!"
echo "📧 Check your email inbox"
echo "📊 Check Waka dashboard for logs"
