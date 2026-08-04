# DealerShot: Foundation

Build a web app called DealerShot — a SaaS tool for car dealerships to manage vehicle inventory and photos. For this first step, I only want the foundation: the database and a working login system. Do NOT build inventory, photos, or other features yet.

Set up these database tables in Supabase:

dealerships — id, name, logo_url, address, phone, subscription_status (default "active"), created_at

profiles — id (links to auth user), email, full_name, role (one of: "owner", "dealer_admin", "staff"), dealership_id (links to dealerships, can be empty for owner), created_at

vehicles — id, dealership_id, vin, year, make, model, trim, body_class, engine, cylinders, transmission, drivetrain, fuel_type, exterior_color, interior_color, odometer, price, stock_number, condition, status, created_at (just create the table, no UI yet)

photos — id, vehicle_id, image_url, shot_type, overlay_id, created_at (just the table, no UI)

overlay_templates — id, dealership_id, name, image_url, category, created_at (just the table, no UI)

For authentication and access control:

Use Supabase email/password authentication

Create a clean login page with the email and password fields, branded with "DealerShot" at the top, centered card on a dark navy background

After login, redirect users to a simple placeholder dashboard page that says "Welcome" and shows their name and role

Protect all pages: anyone not logged in must be redirected to the login page

Set up Row Level Security so users can only see data from their own dealership, except users with role "owner" who can see everything

Keep the design clean, modern, and professional using dark navy (#1a2332) and white as the main colors. Do not add extra features beyond what I listed.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://dealershot.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/ce5eb0f1-0578-4e12-949c-cdcf98b881cb).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
