"""
STATIC SEO / FAVICON FILES — served explicitly (rather than relying on a
generic static folder) since this Flask app has no separate /static
route configured; everything is served from the project root via
send_from_directory. Correct mimetypes matter here: browsers and
crawlers can be picky about robots.txt/sitemap.xml not being served as
text/plain or application/xml respectively.
"""
from flask import Blueprint, send_from_directory

static_bp = Blueprint("static_routes", __name__)


@static_bp.route("/")
def home():
    return send_from_directory(".", "index.html")


@static_bp.route("/style.css")
def style_css():
    return send_from_directory(".", "style.css", mimetype="text/css")


@static_bp.route("/script.js")
def script_js():
    return send_from_directory(".", "script.js", mimetype="application/javascript")


@static_bp.route("/favicon.ico")
def favicon_ico():
    return send_from_directory(".", "favicon.ico", mimetype="image/vnd.microsoft.icon")


@static_bp.route("/favicon-16x16.png")
def favicon_16():
    return send_from_directory(".", "favicon-16x16.png", mimetype="image/png")


@static_bp.route("/favicon-32x32.png")
def favicon_32():
    return send_from_directory(".", "favicon-32x32.png", mimetype="image/png")


@static_bp.route("/favicon-48x48.png")
def favicon_48():
    return send_from_directory(".", "favicon-48x48.png", mimetype="image/png")


@static_bp.route("/apple-touch-icon.png")
def apple_touch_icon():
    return send_from_directory(".", "apple-touch-icon.png", mimetype="image/png")


@static_bp.route("/android-chrome-192x192.png")
def android_chrome_192():
    return send_from_directory(".", "android-chrome-192x192.png", mimetype="image/png")


@static_bp.route("/android-chrome-512x512.png")
def android_chrome_512():
    return send_from_directory(".", "android-chrome-512x512.png", mimetype="image/png")


@static_bp.route("/site.webmanifest")
def site_webmanifest():
    return send_from_directory(".", "site.webmanifest", mimetype="application/manifest+json")


@static_bp.route("/robots.txt")
def robots_txt():
    return send_from_directory(".", "robots.txt", mimetype="text/plain")


@static_bp.route("/sitemap.xml")
def sitemap_xml():
    return send_from_directory(".", "sitemap.xml", mimetype="application/xml")
