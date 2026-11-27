CREATE TABLE public.dispatch (
  id integer PRIMARY KEY CHECK (id = 1),
  revision integer NOT NULL,
  data jsonb NOT NULL
);
ALTER TABLE public.dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.dispatch FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.dispatch FROM authenticated;
  END IF;
END $$;
INSERT INTO public.dispatch (id, revision, data)
VALUES (1, 0, '{"jobs":[],"positions":{},"shifts":[],"seq":1000}');
