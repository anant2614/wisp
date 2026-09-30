### Page
- Page URL: https://app.example.com/signup
- Page Title: Sign up
### Snapshot
```yaml
- generic [active] [ref=e1]:
  - heading "Create your account" [level=1] [ref=e2]
  - link "Pricing" [ref=e3] [cursor=pointer]:
    - /url: /pricing
  - generic [ref=e4]:
    - generic [ref=e5]:
      - text: Full name
      - textbox "Full name" [ref=e6]
    - generic [ref=e7]:
      - text: Email
      - textbox "Email" [ref=e8]
    - generic [ref=e9]:
      - text: Password
      - textbox "Password" [ref=e10]
    - checkbox "I agree to the terms" [ref=e11]
    - button "Show password" [ref=e12]
    - button "Create account" [ref=e13]
  - searchbox "Search docs" [ref=e14]
  - button "Accept all cookies" [ref=e15]
  - button "Compare plans" [ref=e16]
  - button [ref=e17]
  - link "Sign out" [ref=e18] [cursor=pointer]:
    - /url: /logout
```
