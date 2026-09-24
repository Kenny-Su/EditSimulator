from pathlib import Path

from dotenv import load_dotenv

from workbench.app import create_app

load_dotenv(Path(__file__).with_name(".env"), override=False)
app = create_app()

if __name__ == "__main__":
    # Do not use a reloader: startup marks abandoned pending runs interrupted.
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
