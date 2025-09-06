#!/bin/bash

echo "Testing new pool initialization..."
echo "================================"

# Test pool address (you provided this one)
TEST_POOL="0xBb7EfF3E685c6564F2F09DD90b6C05754E3BDAC0"

echo -e "\n1. First request to new pool (should show initializing):"
curl -s "http://localhost:3001/api/stats?pool=$TEST_POOL&interval=15m" | jq '.'

echo -e "\n2. Waiting 5 seconds for pool initialization..."
sleep 5

echo -e "\n3. Second request (should have data if pool is valid):"
curl -s "http://localhost:3001/api/stats?pool=$TEST_POOL&interval=15m" | jq '.'

echo -e "\n4. Testing price endpoint:"
curl -s "http://localhost:3001/api/price?pool=$TEST_POOL" | jq '.'

echo -e "\n5. Testing volume endpoint:"
curl -s "http://localhost:3001/api/volume?pool=$TEST_POOL" | jq '.'