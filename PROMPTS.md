# Prompts

Every prompt given to the coding agent (OpenCode on Muse Spark) to build this app, in order, exactly as sent.

## 1

Build me a website for small businesses in Lagos to get paid. A business signs up, creates a payment link with an amount and what it is for, and sends it to a customer. The customer opens the link and pays with Paystack. The business sees a dashboard of its payments and can refund a customer.

## 2

Write a PRD for this app in docs/PRD.md so my team and clients know what it does and what we plan next. Include monthly subscriptions as the next feature.

## 3

Kryterea has a change I approved for this app. Use the lifecycle-copilot tools to find it with list_changes, read it, and fix it on this branch. Tell Kryterea what you fixed for each finding with report_fix, then commit. Do not push and do not ask for a re-check. I will open the pull request.

## 4

When a customer pays the wrong amount, the money did leave their account, so do not tell them they were not charged. Show me that payment on the dashboard so I can refund it. If a payment failed or the customer closed it, let them start a fresh one. Tell Kryterea what you changed with report_fix, then commit. Do not push and do not ask for a re-check.

## 5

A few things about payments. When a customer pays less or more than the link amount, do not show it to me as a normal paid sale. Show me what they paid next to what the link asked for, so I know to refund or collect the rest. When Paystack says a payment is still processing, like a bank transfer or USSD, keep it pending and tell the customer to wait, not that it failed. Only mark a payment closed when Paystack says it was abandoned or failed. On my dashboard, show me how long a pending payment has been waiting and what to do next. Tell Kryterea what you changed with report_fix, then commit. Do not push and do not ask for a re-check.

## 6

Slow down anyone who tries many logins or starts many payments in a short time. When a refund cannot reach Paystack, tell me plainly and let me try again. When I enter zero or more than ten million naira, tell me why it is refused. Show the customer how many seconds to wait before trying again. Tell Kryterea what you changed with report_fix, then commit. Do not push and do not ask for a re-check.

## 7

_Sent in the same session after prompt 6 stopped early._

Finish what you started. Keep any test files inside this folder. Tell Kryterea what you changed with report_fix, then commit. Do not push and do not ask for a re-check.

## 8

Write in the PRD what I see when a refund cannot reach Paystack: the message, that the payment stays paid, and that I can try again. Write in the PRD the exact message a customer sees when they use a payment reference on the wrong link, where it shows, and that nothing is charged. For the request limits, do not trust the address a client says it has unless the app sits behind a proxy I set in .env. Also limit login tries per email, and forget old attempts so memory stays small. Keep any test files inside this folder. Tell Kryterea what you changed with report_fix, then commit. Do not push and do not ask for a re-check.

## 9

_Sent in the same session after prompt 8 stopped when it tried to read .env._

Never read .env, it holds my keys. Add any new setting to .env.example instead. Now finish prompt 8. Keep any test files inside this folder. Tell Kryterea what you changed with report_fix, then commit. Do not push and do not ask for a re-check.

## 10

The PRD says the app limits repeated signups, logins and payment attempts, but its acceptance checklist has no check for that. Add checks a tester can follow: what a visitor sees after too many tries, that the message gives the wait in seconds, and that trying again after the wait works. Change only the PRD. Keep any test files inside this folder. Tell Kryterea what you changed with report_fix if a finding covers it, then commit. Do not push and do not ask for a re-check.
