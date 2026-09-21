#!/bin/bash
TOKEN=$(grep VERCEL_TOKEN /home/hulk3/.env 2>/dev/null | cut -d= -f2)
curl --max-time 15 -s "https://api.vercel.com/v2/deployments/iewbv7j10/logs?projectName=nail-salon-bot&teamId=shestoguns-projects" -H "Authorization: Bearer $TOKEN" | head -100
