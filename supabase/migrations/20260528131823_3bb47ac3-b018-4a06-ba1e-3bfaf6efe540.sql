
-- Enum for user roles
CREATE TYPE public.app_role AS ENUM ('owner', 'dealer_admin', 'staff');

-- Dealerships table
CREATE TABLE public.dealerships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  logo_url TEXT,
  address TEXT,
  phone TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  role public.app_role NOT NULL DEFAULT 'staff',
  dealership_id UUID REFERENCES public.dealerships(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vehicles table
CREATE TABLE public.vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id UUID NOT NULL REFERENCES public.dealerships(id) ON DELETE CASCADE,
  vin TEXT,
  year INTEGER,
  make TEXT,
  model TEXT,
  trim TEXT,
  body_class TEXT,
  engine TEXT,
  cylinders INTEGER,
  transmission TEXT,
  drivetrain TEXT,
  fuel_type TEXT,
  exterior_color TEXT,
  interior_color TEXT,
  odometer INTEGER,
  price NUMERIC(12,2),
  stock_number TEXT,
  condition TEXT,
  status TEXT DEFAULT 'available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Photos table
CREATE TABLE public.photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id UUID NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  shot_type TEXT,
  overlay_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Overlay templates table
CREATE TABLE public.overlay_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id UUID REFERENCES public.dealerships(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dealerships TO authenticated;
GRANT ALL ON public.dealerships TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicles TO authenticated;
GRANT ALL ON public.vehicles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.photos TO authenticated;
GRANT ALL ON public.photos TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.overlay_templates TO authenticated;
GRANT ALL ON public.overlay_templates TO service_role;

-- Security definer functions to avoid RLS recursion
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.get_user_dealership(_user_id UUID)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT dealership_id FROM public.profiles WHERE id = _user_id;
$$;

-- Enable RLS
ALTER TABLE public.dealerships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overlay_templates ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Owners can insert profiles" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Owners can delete profiles" ON public.profiles FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));

-- Dealerships policies
CREATE POLICY "View own dealership" ON public.dealerships FOR SELECT TO authenticated
  USING (id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Owners manage dealerships - insert" ON public.dealerships FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Owners manage dealerships - update" ON public.dealerships FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Owners manage dealerships - delete" ON public.dealerships FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));

-- Vehicles policies
CREATE POLICY "View vehicles in dealership" ON public.vehicles FOR SELECT TO authenticated
  USING (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Insert vehicles in dealership" ON public.vehicles FOR INSERT TO authenticated
  WITH CHECK (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Update vehicles in dealership" ON public.vehicles FOR UPDATE TO authenticated
  USING (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Delete vehicles in dealership" ON public.vehicles FOR DELETE TO authenticated
  USING (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));

-- Photos policies (via vehicle's dealership)
CREATE POLICY "View photos in dealership" ON public.photos FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_id AND v.dealership_id = public.get_user_dealership(auth.uid())
  ));
CREATE POLICY "Insert photos in dealership" ON public.photos FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'owner') OR EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_id AND v.dealership_id = public.get_user_dealership(auth.uid())
  ));
CREATE POLICY "Update photos in dealership" ON public.photos FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_id AND v.dealership_id = public.get_user_dealership(auth.uid())
  ));
CREATE POLICY "Delete photos in dealership" ON public.photos FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_id AND v.dealership_id = public.get_user_dealership(auth.uid())
  ));

-- Overlay templates policies
CREATE POLICY "View overlays in dealership" ON public.overlay_templates FOR SELECT TO authenticated
  USING (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Insert overlays in dealership" ON public.overlay_templates FOR INSERT TO authenticated
  WITH CHECK (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Update overlays in dealership" ON public.overlay_templates FOR UPDATE TO authenticated
  USING (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Delete overlays in dealership" ON public.overlay_templates FOR DELETE TO authenticated
  USING (dealership_id = public.get_user_dealership(auth.uid()) OR public.has_role(auth.uid(), 'owner'));

-- Trigger: auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'staff'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
