"""
App factory — creates the Flask app, wires CORS, initializes the
Postgres schema once at startup (not at import time — see db.py), and
registers every route blueprint.

The top-level entrypoint (app.py at the repo root, the file Vercel's
@vercel/python build actually points at) just does:

    from server import create_app
    app = create_app()

and Vercel's Python runtime picks up `app` as the WSGI callable.
"""
from flask import Flask
from flask_cors import CORS
import os

from server.db import init_db
from server.firestore_db import init_firestore
from server.routes.auth_routes import auth_bp
from server.routes.provider_routes import provider_bp
from server.routes.static_routes import static_bp
from server.routes.api_routes import api_bp
from server.routes.chat_routes import chat_bp
from server.routes.file_routes import file_bp
from server.routes.session_routes import session_bp

# static_routes.py and file_routes.py both call send_from_directory(".", ...)
# to serve index.html, favicons, robots.txt, etc. from the REPO ROOT (where
# they actually live, alongside vercel.json) — carried over unchanged from
# the original single-file server.py, where Flask(__name__) lived at the
# repo root so "." naturally meant repo root. Now that Flask(__name__) is
# constructed here inside server/__init__.py, Flask's default root_path
# would instead resolve to this file's own directory (server/), one level
# below where those static assets live — which would silently 404 every
# static/SEO route. Passing root_path explicitly restores the original
# behavior without having to touch every send_from_directory(".", ...)
# call site.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def create_app():
    app = Flask(__name__, root_path=_REPO_ROOT)
    CORS(app, supports_credentials=True)

    # Importing server.config (transitively, via the blueprint imports
    # above) already validates required env vars and raises at import
    # time if any are missing — so by the time we get here, config is
    # known-good and it's safe to touch the database.
    init_db()
    init_firestore()

    app.register_blueprint(auth_bp)
    app.register_blueprint(provider_bp)
    app.register_blueprint(static_bp)
    app.register_blueprint(api_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(file_bp)
    app.register_blueprint(session_bp)

    return app
