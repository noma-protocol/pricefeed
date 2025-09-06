#!/bin/bash

echo "Testing pool endpoint..."
echo "========================"

POOL="0xBb7EfF3E685c6564F2F09DD90b6C05754E3BDAC0"

echo -e "\n1. Testing /api/price with pool:"
curl -s "http://localhost:3001/api/price?pool=$POOL" | jq '.'

echo -e "\n2. Testing /api/price/24h with pool:"
curl -s "http://localhost:3001/api/price/24h?pool=$POOL" | jq '.'

echo -e "\n3. Testing if pool has OHLC data:"
curl -s "http://localhost:3001/api/price/ohlc/all?pool=$POOL" | jq '.ohlc | to_entries | map({key: .key, length: (.value | length)})'

echo -e "\n4. Testing default pool (should work):"
curl -s "http://localhost:3001/api/price/24h" | jq '.'