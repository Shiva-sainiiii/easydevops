"""
WSGI entrypoint. Vercel's @vercel/python builder needs one file at the
repo root exposing a module-level `app` object — this is that file.

Deliberately kept to two lines: all real logic lives in the server/
package (see server/__init__.py for the app factory and blueprint
wiring). Named app.py rather than server.py specifically to avoid a
naming collision with the server/ package directory sitting right next
to it — `import server` would be ambiguous if a server.py module also
existed at the same level.
"""
from server import create_app

app = create_app()
