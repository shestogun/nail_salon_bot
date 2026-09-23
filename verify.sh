#!/bin/bash
# Verify webhook fixes
set -e

echo "=== Checking webhook/index.js ==="
node -c api/webhook/index.js && echo "✅ Syntax OK"

# Check no top-level initTables
grep -q 'db.initTables()' api/webhook/index.js && echo "❌ Still has top-level initTables" || echo "✅ No top-level initTables"

# Check tgEdit signature
grep -q 'async function tgEdit(text, opts' api/webhook/index.js && echo "✅ tgEdit signature OK" || echo "❌ tgEdit signature wrong"

# Check req.text()
grep -q 'await req.text()' api/webhook/index.js && echo "✅ req.text() used" || echo "❌ req.text() missing"

# Check no bot.* calls
grep -q 'bot\.' api/webhook/index.js && echo "❌ Still has bot.* calls" || echo "✅ No bot.* calls"

echo ""
echo "=== Checking database.js ==="
node -c database.js && echo "✅ Syntax OK"
grep -q 'getSql()' database.js && echo "✅ Lazy neon init" || echo "❌ No lazy init"
grep -q 'const sql = neon(' database.js && echo "❌ Still has const sql = neon(" || echo "✅ No top-level neon()"

echo ""
echo "=== All checks complete ==="
