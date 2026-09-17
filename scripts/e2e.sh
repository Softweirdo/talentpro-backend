#!/bin/bash
# End-to-end smoke test of the TalentPro API.
set -uo pipefail
API=http://localhost:4000/api/v1
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; echo "     $2" | head -c 400; echo; FAIL=$((FAIL+1)); }
j(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=process.argv[1].split('.').reduce((a,k)=>a?.[k],o);console.log(v===null||v===undefined?'':(typeof v==='object'?JSON.stringify(v):v))}catch(e){console.log('')}})" "$1"; }

# Reseed first: several checks consume one-shot state (the last unassigned
# employee code, the pending reward, a history row), so the suite must start
# from a known database to be repeatable.
echo "── 0. Reseed ─────────────────────────────────────────────"
if npm run seed:fresh --silent > /tmp/e2e-seed.log 2>&1; then
  ok "database reseeded"
else
  no "reseed failed" "$(tail -3 /tmp/e2e-seed.log)"
fi

echo "── 1. Employee OTP login ─────────────────────────────────"
R=$(curl -s -X POST $API/auth/otp/request -H 'Content-Type: application/json' -d '{"mobile":"9876543210"}')
REQ=$(echo "$R" | j data.requestId); CODE=$(echo "$R" | j data.devCode)
[ -n "$REQ" ] && ok "OTP requested (masked: $(echo "$R" | j data.maskedMobile))" || no "OTP request" "$R"

R=$(curl -s -X POST $API/auth/otp/request -H 'Content-Type: application/json' -d '{"mobile":"9876543210"}')
[ "$(echo "$R" | j error.code)" = "OTP_COOLDOWN" ] && ok "resend cooldown enforced" || no "cooldown" "$R"

R=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d "{\"requestId\":\"$REQ\",\"code\":\"000000\"}")
[ "$(echo "$R" | j error.code)" = "OTP_INVALID" ] && ok "wrong code rejected" || no "wrong code" "$R"

R=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d "{\"requestId\":\"$REQ\",\"code\":\"$CODE\"}")
TOK=$(echo "$R" | j data.accessToken); REF=$(echo "$R" | j data.refreshToken)
[ -n "$TOK" ] && ok "signed in as $(echo "$R" | j data.employee.name) ($(echo "$R" | j data.employee.employeeCode))" || no "verify" "$R"
A="Authorization: Bearer $TOK"

echo "── 2. Profile & employment lock ──────────────────────────"
R=$(curl -s $API/me -H "$A")
[ "$(echo "$R" | j data.currentOrganization)" = "" ] && ok "profile: Currently Unemployed" || no "profile" "$R"
[ "$(echo "$R" | j data.employmentHistory.0.company)" = "Welspun Corp" ] && ok "employment history: Welspun Corp, $(echo "$R" | j data.employmentHistory.0.period)" || no "history" "$R"

R=$(curl -s -X PATCH $API/me -H "$A" -H 'Content-Type: application/json' -d '{"expectedSalary":27000,"currentOrganization":"Hacked Ltd"}')
[ "$(echo "$R" | j data.expectedSalary)" = "27000" ] && [ "$(echo "$R" | j data.currentOrganization)" = "" ] && ok "salary editable, currentOrganization ignored (admin-locked)" || no "profile patch" "$R"

echo "── 3. Job feed & apply ───────────────────────────────────"
R=$(curl -s "$API/jobs?limit=5" -H "$A")
JOB=$(echo "$R" | j data.0.id)
[ -n "$JOB" ] && ok "feed: $(echo "$R" | j data.0.title) @ $(echo "$R" | j data.0.company) — isNew=$(echo "$R" | j data.0.isNew)" || no "feed" "$R"
R=$(curl -s "$API/jobs/recommended" -H "$A"); ok "recommended: $(echo "$R" | j data.0.title)"

R=$(curl -s -X POST $API/jobs/$JOB/apply -H "$A")
[ -n "$(echo "$R" | j data.id)" ] && ok "applied (or already applied: $(echo "$R" | j meta.alreadyApplied))" || no "apply" "$R"
R2=$(curl -s -X POST $API/jobs/$JOB/apply -H "$A")
[ "$(echo "$R2" | j meta.alreadyApplied)" = "true" ] && ok "double-tap returns the same application, not an error" || no "idempotent apply" "$R2"

echo "── 4. Refer a friend ─────────────────────────────────────"
NEW=98$(( RANDOM % 90000000 + 10000000 ))
R=$(curl -s -X POST $API/referrals -H "$A" -H 'Content-Type: application/json' -d "{\"friendName\":\"Test Friend\",\"friendMobile\":\"$NEW\",\"jobId\":\"$JOB\"}")
NEWREF=$(echo "$R" | j data.id)
[ -n "$NEWREF" ] && ok "referral created — ₹$(echo "$R" | j data.rewardAmount) / $(echo "$R" | j data.tenureMonths)mo snapshotted" || no "referral" "$R"

R=$(curl -s -X POST $API/referrals -H "$A" -H 'Content-Type: application/json' -d "{\"friendName\":\"Dup\",\"friendMobile\":\"$NEW\"}")
[ "$(echo "$R" | j error.code)" = "FRIEND_ALREADY_REFERRED" ] && ok "first-referrer-wins enforced by the index" || no "dup referral" "$R"

R=$(curl -s -X POST $API/referrals -H "$A" -H 'Content-Type: application/json' -d '{"friendName":"Me","friendMobile":"9876543210"}')
[ "$(echo "$R" | j error.code)" = "SELF_REFERRAL" ] && ok "self-referral rejected" || no "self referral" "$R"

R=$(curl -s $API/referrals/stats -H "$A")
ok "my referrals: $(echo "$R" | j data.totalReferrals) · earned ₹$(echo "$R" | j data.moneyEarned)"

R=$(curl -s "$API/referrals?limit=20" -H "$A")
ok "tenure counter derived on read: $(echo "$R" | j data.0.friendName) → $(echo "$R" | j data.0.tenure)"

echo "── 4b. Gujarati registration ─────────────────────────────"
# Regression guard: a text index reads a document's own `language` field to
# pick a stemmer, and MongoDB has no Gujarati one — so saving a gu profile used
# to fail with "language override unsupported: gu".
NEWU=97$(( RANDOM % 90000000 + 10000000 ))
R=$(curl -s -X POST $API/auth/otp/request -H 'Content-Type: application/json' -d "{\"mobile\":\"$NEWU\"}")
RQ=$(echo "$R" | j data.requestId); CD=$(echo "$R" | j data.devCode)
RT=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d "{\"requestId\":\"$RQ\",\"code\":\"$CD\"}" | j data.registrationToken)
CAT=$(curl -s $API/categories | j data.0.id)
R=$(curl -s -X POST $API/auth/register -H "Authorization: Bearer $RT" -H 'Content-Type: application/json' \
  -d "{\"name\":\"દિનેશ પટેલ\",\"age\":34,\"experienceBand\":\"1-3\",\"categoryId\":\"$CAT\",\"presentSalary\":15000,\"expectedSalary\":22000,\"language\":\"gu\"}")
[ "$(echo "$R" | j data.employee.language)" = "gu" ] && ok "Gujarati name + language=gu saved: $(echo "$R" | j data.employee.name)" || no "gujarati registration" "$R"

echo "── 5. Admin auth & audience isolation ────────────────────"
R=$(curl -s -X POST $API/admin/auth/login -H 'Content-Type: application/json' -d '{"email":"jimit@mpowersolutions.in","password":"ChangeMe@123"}')
ADM=$(echo "$R" | j data.accessToken)
[ -n "$ADM" ] && ok "admin signed in: $(echo "$R" | j data.admin.name) ($(echo "$R" | j data.admin.role))" || no "admin login" "$R"
AA="Authorization: Bearer $ADM"

R=$(curl -s -X POST $API/admin/auth/login -H 'Content-Type: application/json' -d '{"email":"jimit@mpowersolutions.in","password":"wrong"}')
[ "$(echo "$R" | j error.code)" = "INVALID_CREDENTIALS" ] && ok "bad admin password rejected" || no "bad password" "$R"

R=$(curl -s -o /dev/null -w '%{http_code}' $API/admin/employees -H "$A")
[ "$R" = "401" ] && ok "employee token on an admin route → 401 (separate signing secret)" || no "audience isolation returned $R" "$R"

echo "── 6. Admin dashboard ────────────────────────────────────"
R=$(curl -s $API/admin/analytics/overview -H "$AA")
ok "overview: $(echo "$R" | j data.registeredEmployees.value) employees · $(echo "$R" | j data.activeJobs.value) active jobs · $(echo "$R" | j data.totalReferrals.value) referrals · hire rate $(echo "$R" | j data.hireRate.value)%"
R=$(curl -s $API/admin/analytics/funnel -H "$AA")
ok "funnel: $(echo "$R" | j data)"
R=$(curl -s $API/admin/analytics/top-referrers -H "$AA")
ok "top referrer: $(echo "$R" | j data.0.name) — $(echo "$R" | j data.0.shares) shares"
R=$(curl -s $API/admin/analytics/action-items -H "$AA")
ok "action items: $(echo "$R" | j data)"

echo "── 7. Pipeline: shortlist → interview → hire ─────────────"
R=$(curl -s "$API/admin/applications/board" -H "$AA")
ok "board: $(echo "$R" | j data.0.status)=$(echo "$R" | j data.0.total) $(echo "$R" | j data.1.status)=$(echo "$R" | j data.1.total) $(echo "$R" | j data.2.status)=$(echo "$R" | j data.2.total) $(echo "$R" | j data.3.status)=$(echo "$R" | j data.3.total)"

APP=$(curl -s "$API/admin/applications?status=applied&perPage=1" -H "$AA" | j data.0.id)
R=$(curl -s -X PATCH $API/admin/applications/$APP/status -H "$AA" -H 'Content-Type: application/json' -d '{"status":"shortlisted"}')
[ "$(echo "$R" | j data.status)" = "shortlisted" ] && ok "shortlisted $(echo "$R" | j data.employee.name)" || no "shortlist" "$R"

R=$(curl -s -X PATCH $API/admin/applications/$APP/status -H "$AA" -H 'Content-Type: application/json' -d '{"status":"hired","hiredOn":"2026-09-01"}')
[ "$(echo "$R" | j data.status)" = "hired" ] && ok "hired on $(echo "$R" | j data.hiredDate)" || no "hire" "$R"
CONF=$(echo "$R" | j meta.employmentConflict.currentOrganization)
[ -n "$CONF" ] && ok "employment conflict flagged, not overwritten (was at: $CONF)" || ok "employment updated from the hire event"

R=$(curl -s -X PATCH $API/admin/applications/$APP/status -H "$AA" -H 'Content-Type: application/json' -d '{"status":"applied"}')
[ "$(echo "$R" | j error.code)" = "INVALID_TRANSITION" ] && ok "invalid pipeline move rejected (hired → applied)" || no "transition guard" "$R"

echo "── 8. Inline org edit & history archiving ────────────────"
EMP=$(curl -s "$API/admin/employees?q=Ramesh" -H "$AA" | j data.0.id)
R=$(curl -s -X PUT $API/admin/employees/$EMP/current-organization -H "$AA" -H 'Content-Type: application/json' -d '{"company":"Tata Motors"}')
[ "$(echo "$R" | j data.currentOrganization)" = "Tata Motors" ] && ok "set current org → Tata Motors" || no "set org" "$R"

R=$(curl -s -X PUT $API/admin/employees/$EMP/current-organization -H "$AA" -H 'Content-Type: application/json' -d '{"company":"tata motors"}')
[ "$(echo "$R" | j meta.changed)" = "false" ] && ok "same company (different case) is a no-op, no duplicate stint" || no "no-op guard" "$R"

R=$(curl -s -X PUT $API/admin/employees/$EMP/current-organization -H "$AA" -H 'Content-Type: application/json' -d '{"company":"Adani Group"}')
[ "$(echo "$R" | j meta.archived.company)" = "Tata Motors" ] && ok "switching archived Tata Motors to history automatically" || no "archive" "$R"

R=$(curl -s -X DELETE $API/admin/employees/$EMP/current-organization -H "$AA")
[ "$(echo "$R" | j data.currentOrganization)" = "" ] && [ "$(echo "$R" | j meta.archived.company)" = "Adani Group" ] && ok "cleared → Currently Unemployed, Adani Group moved to history" || no "clear org" "$R"

HID=$(curl -s $API/admin/employees/$EMP -H "$AA" | j data.employmentHistory.0.id)
R=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/admin/employees/$EMP/employment-history/$HID -H "$AA")
[ "$R" = "200" ] && ok "closed history entry deletable" || no "history delete returned $R" ""

echo "── 9. Employee code assignment ───────────────────────────"
PEND=$(curl -s "$API/admin/employees?hasCode=no&perPage=1" -H "$AA" | j data.0.id)
if [ -z "$PEND" ]; then no "no employee awaiting a code" "seed should leave exactly one"; fi
R=$(curl -s -X POST $API/admin/employees/${PEND:-missing}/assign-code -H "$AA")
[ -n "$(echo "$R" | j data.employeeCode)" ] && ok "assigned $(echo "$R" | j data.employeeCode) to $(echo "$R" | j data.name)" || no "assign code" "$R"
R=$(curl -s -X POST $API/admin/employees/$PEND/assign-code -H "$AA")
[ "$(echo "$R" | j error.code)" = "CODE_ALREADY_ASSIGNED" ] && ok "re-assignment blocked" || no "reassign" "$R"

echo "── 10. Tenure cron → reward → payout ─────────────────────"
BEFORE=$(curl -s "$API/admin/rewards?status=pending_approval" -H "$AA" | j page.total)
npm run tenure:run --silent > /tmp/tenure.log 2>&1
AFTER=$(curl -s "$API/admin/rewards?status=pending_approval" -H "$AA" | j page.total)
ok "tenure sweep: pending rewards $BEFORE → $AFTER"

npm run tenure:run --silent > /tmp/tenure2.log 2>&1
AGAIN=$(curl -s "$API/admin/rewards?status=pending_approval" -H "$AA" | j page.total)
[ "$AFTER" = "$AGAIN" ] && ok "cron is idempotent — second run created no duplicate rewards" || no "idempotency: $AFTER vs $AGAIN" ""

RW=$(curl -s "$API/admin/rewards?status=pending_approval&perPage=1" -H "$AA")
RID=$(echo "$RW" | j data.0.id); RUID=$(echo "$RW" | j data.0.referrer.id)
if [ -n "$RID" ]; then
  ok "pending: $(echo "$RW" | j data.0.referrer.name) → $(echo "$RW" | j data.0.referral.friendName), suggested ₹$(echo "$RW" | j data.0.suggestedAmount)"
  EARNED_BEFORE=$(curl -s $API/admin/employees/$RUID -H "$AA" | j data.moneyEarned)
  R=$(curl -s -X POST $API/admin/rewards/$RID/approve -H "$AA" -H 'Content-Type: application/json' -d '{"amount":3200,"markPaid":true,"paymentMethod":"upi"}')
  [ "$(echo "$R" | j data.status)" = "paid" ] && ok "approved at an edited ₹$(echo "$R" | j data.approvedAmount) (suggested ₹$(echo "$R" | j data.suggestedAmount))" || no "approve" "$R"
  EARNED_AFTER=$(curl -s $API/admin/employees/$RUID -H "$AA" | j data.moneyEarned)
  ok "moneyEarned recomputed from the ledger: ₹$EARNED_BEFORE → ₹$EARNED_AFTER"
  R=$(curl -s -X POST $API/admin/rewards/$RID/approve -H "$AA" -H 'Content-Type: application/json' -d '{}')
  [ "$(echo "$R" | j meta.alreadyPaid)" = "true" ] && ok "replayed approval is a no-op, not a double payout" || no "double pay guard" "$R"
else
  no "no pending reward found" "$RW"
fi

echo "── 11. Rewards stats & referral funnel ───────────────────"
R=$(curl -s $API/admin/rewards/stats -H "$AA")
ok "rewards: $(echo "$R" | j data.pendingApproval) pending · ₹$(echo "$R" | j data.totalPaid) paid all-time · avg ₹$(echo "$R" | j data.averageReward)"
R=$(curl -s $API/admin/referrals/stats -H "$AA")
ok "referral funnel: $(echo "$R" | j data.totalShares) shares → hired $(echo "$R" | j data.hired.count) ($(echo "$R" | j data.hired.rate)%)"

echo "── 12. Settings, categories, exports ─────────────────────"
R=$(curl -s -X PATCH $API/admin/settings -H "$AA" -H 'Content-Type: application/json' -d '{"defaultRewardAmount":2750,"smsApiKey":"super-secret-key-value"}')
[ "$(echo "$R" | j data.defaultRewardAmount)" = "2750" ] && ok "settings updated; API key returned masked as $(echo "$R" | j data.smsApiKey)" || no "settings" "$R"
R=$(curl -s $API/admin/categories -H "$AA")
ok "categories: $(echo "$R" | j data.0.name) ($(echo "$R" | j data.0.employeeCount) emp · $(echo "$R" | j data.0.jobCount) jobs)"
for e in employees jobs applications referrals rewards; do
  N=$(curl -s "$API/admin/exports/$e.csv" -H "$AA" | wc -l | tr -d ' ')
  [ "$N" -gt 1 ] && ok "export $e.csv → $N lines" || no "export $e" "$N lines"
done

echo "── 13. Token refresh & reuse detection ───────────────────"
R=$(curl -s -X POST $API/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REF\"}")
REF2=$(echo "$R" | j data.refreshToken)
[ -n "$REF2" ] && ok "refresh rotated the token" || no "refresh" "$R"
R=$(curl -s -X POST $API/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REF\"}")
[ "$(echo "$R" | j error.code)" = "REFRESH_REUSED" ] && ok "replaying the old token revoked the whole family" || no "reuse detection" "$R"
R=$(curl -s -X POST $API/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REF2\"}")
[ -n "$(echo "$R" | j error.code)" ] && ok "the rotated token was revoked with the family too" || no "family revocation" "$R"

echo
echo "═════════════════════════════════════════════════════════"
echo "  $PASS passed · $FAIL failed"
echo "═════════════════════════════════════════════════════════"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
