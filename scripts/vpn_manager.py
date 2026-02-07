#!/usr/bin/env python3
"""
VPN Manager for WireGuard configuration rotation.

Manages WireGuard VPN connections for scraping, allowing IP rotation
when bot detection is detected or for distributing load across multiple IPs.

Uses file locking to prevent multiple processes from using VPN simultaneously.

Usage:
    vpn = VPNManager(total_configs=50)

    # Rotate to a random VPN config
    vpn.rotate_vpn()

    # Scraping here...

    # Rotate when blocked
    vpn.rotate_vpn()

    # Disable VPN and use regular IP
    vpn.disable_vpn()
"""
import subprocess
import random
import time
import logging
import fcntl
import os

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=__import__('sys').stderr)

# Lock file to prevent concurrent VPN usage
VPN_LOCK_FILE = "/tmp/vpn_manager.lock"


class VPNManager:
    """Manages WireGuard VPN configuration rotation with file locking."""

    def __init__(self, total_configs=50, config_dir="/etc/wireguard", config_prefix="v"):
        """
        Initialize VPN manager.

        Args:
            total_configs: Number of VPN configs available (1 to total_configs)
            config_dir: Directory where WireGuard configs are stored
            config_prefix: Prefix for config files (e.g., "v" for v1.conf, v2.conf)
        """
        self.total_configs = total_configs
        self.config_dir = config_dir
        self.config_prefix = config_prefix
        self.current_interface = None
        self.vpn_enabled = False
        self.lock_file = None
        self._lock_held = False

    def _acquire_lock(self, timeout=60):
        """
        Acquire exclusive lock to prevent concurrent VPN usage.

        Args:
            timeout: Maximum seconds to wait for lock (default 60)

        Returns:
            True if lock acquired, False if timeout
        """
        if self._lock_held:
            return True  # Already holding lock

        try:
            self.lock_file = open(VPN_LOCK_FILE, 'w')
            # Try to acquire exclusive lock (non-blocking)
            fcntl.lockf(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._lock_held = True
            logging.error(f"[VPN] Acquired VPN lock (PID: {os.getpid()})")
            return True
        except IOError:
            # Lock is held by another process
            logging.error(f"[VPN] VPN lock held by another process, waiting...")
            # Try again with blocking mode and timeout
            start_time = time.time()
            while time.time() - start_time < timeout:
                try:
                    time.sleep(0.5)
                    self.lock_file = open(VPN_LOCK_FILE, 'w')
                    fcntl.lockf(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._lock_held = True
                    logging.error(f"[VPN] Acquired VPN lock after waiting (PID: {os.getpid()})")
                    return True
                except IOError:
                    continue
            logging.error(f"[VPN] Timeout waiting for VPN lock")
            return False

    def _release_lock(self):
        """Release the VPN lock."""
        if self.lock_file and self._lock_held:
            try:
                fcntl.lockf(self.lock_file, fcntl.LOCK_UN)
                self.lock_file.close()
                self._lock_held = False
                logging.error(f"[VPN] Released VPN lock (PID: {os.getpid()})")
            except Exception as e:
                logging.error(f"[VPN] Error releasing lock: {e}")
            finally:
                self.lock_file = None
                self._lock_held = False

    def disable_vpn(self):
        """Shut down any active WireGuard interface we started."""
        if self.current_interface:
            logging.error(f"[VPN] Stopping VPN: {self.current_interface}...")
            result = subprocess.run(
                ["sudo", "wg-quick", "down", self.current_interface],
                capture_output=True,
                text=True
            )
            if result.returncode == 0:
                logging.error(f"[VPN] VPN stopped successfully")
            else:
                logging.error(f"[VPN] Error stopping VPN: {result.stderr}")
            self.current_interface = None
            self.vpn_enabled = False
            # Release lock after disabling VPN
            self._release_lock()
        else:
            logging.error(f"[VPN] No active VPN to disable")

    def _disable_all_wireguard_interfaces(self):
        """
        Disable ALL active WireGuard interfaces, not just the one we started.

        This is important when a new worker process starts and there might be
        a VPN interface active from a previous worker. We scan for ALL interfaces
        matching our config prefix and bring them down.
        """
        try:
            # Get list of all WireGuard interfaces
            result = subprocess.run(
                ["sudo", "wg", "show", "interfaces"],
                capture_output=True,
                text=True,
                timeout=10
            )

            if result.returncode == 0:
                interfaces = result.stdout.strip().split()
                logging.error(f"[VPN] Found active WireGuard interfaces: {interfaces}")

                # Bring down all interfaces matching our config prefix
                for interface in interfaces:
                    if interface.startswith(self.config_prefix):
                        logging.error(f"[VPN] Bringing down interface: {interface}")
                        subprocess.run(
                            ["sudo", "wg-quick", "down", interface],
                            capture_output=True,
                            text=True,
                            timeout=30
                        )
        except Exception as e:
            logging.error(f"[VPN] Error scanning for WireGuard interfaces: {e}")

    def rotate_vpn(self):
        """Pick a random config and switch to it (with locking)."""
        # Acquire lock before rotating
        if not self._acquire_lock(timeout=60):
            logging.error(f"[VPN] Failed to acquire lock for VPN rotation")
            return False

        try:
            # First, disable ANY active WireGuard interfaces to prevent double VPN
            # This handles the case where a previous worker left a VPN active
            self._disable_all_wireguard_interfaces()

            # Also disable our tracked interface if it exists
            if self.current_interface:
                logging.error(f"[VPN] Stopping tracked VPN: {self.current_interface}...")
                subprocess.run(
                    ["sudo", "wg-quick", "down", self.current_interface],
                    capture_output=True,
                    text=True,
                    timeout=30
                )
                self.current_interface = None
                self.vpn_enabled = False

            # Pick a new random config (1 to total_configs)
            new_id = random.randint(1, self.total_configs)
            interface_name = f"{self.config_prefix}{new_id}"
            config_path = f"{self.config_dir}/{interface_name}.conf"

            logging.error(f"[VPN] Rotating to IP from config: {interface_name}.conf")

            # If interface is already up (from previous runs), bring it down first
            try:
                subprocess.run(
                    ["sudo", "wg-quick", "down", interface_name],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
            except:
                pass

            # Bring it up
            result = subprocess.run(
                ["sudo", "wg-quick", "up", config_path],
                capture_output=True,
                text=True,
                timeout=30
            )

            if result.returncode == 0:
                # WireGuard interfaces are named after the filename (without .conf)
                self.current_interface = interface_name
                self.vpn_enabled = True
                # Give the network and DNS more time to settle
                time.sleep(5)
                logging.error(f"[VPN] VPN rotated successfully to interface {interface_name}")
                return True
            else:
                logging.error(f"[VPN] Error starting VPN: {result.stderr}")
                self.vpn_enabled = False
                # Release lock on failure
                self._release_lock()
                return False
        except Exception as e:
            logging.error(f"[VPN] Exception during VPN rotation: {e}")
            self._release_lock()
            return False

    def cleanup_all(self):
        """
        Disable ALL VPNs and release lock.

        Use this at the end of a job to return to residential IP.
        Ensures clean state for the next job.
        """
        logging.error(f"[VPN] Cleaning up ALL VPNs and returning to residential IP...")
        self._disable_all_wireguard_interfaces()
        self._release_lock()

    def get_current_ip(self):
        """Get the current public IP address."""
        try:
            result = subprocess.run(
                ["curl", "-s", "https://api.ipify.org"],
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except Exception as e:
            logging.error(f"[VPN] Error getting current IP: {e}")
        return "Unknown"


def create_vpn_manager(total_configs=50, config_dir="/etc/wireguard", config_prefix=""):
    """
    Factory function to create a VPN manager.

    Args:
        total_configs: Number of VPN configs available
        config_dir: Directory where WireGuard configs are stored
        config_prefix: Prefix for config files (e.g., "v" for v1.conf, v2.conf)

    Returns:
        VPNManager instance or None if VPN is not available
    """
    try:
        # Check if WireGuard is available
        result = subprocess.run(
            ["which", "wg-quick"],
            capture_output=True
        )
        if result.returncode != 0:
            logging.error("[VPN] WireGuard (wg-quick) not found - VPN management disabled")
            return None

        # Check if we have sudo access
        result = subprocess.run(
            ["sudo", "-n", "true"],
            capture_output=True
        )
        if result.returncode != 0:
            logging.error("[VPN] No sudo access - VPN management disabled")
            return None

        return VPNManager(total_configs=total_configs, config_dir=config_dir, config_prefix=config_prefix)
    except Exception as e:
        logging.error(f"[VPN] VPN manager initialization failed: {e}")
        return None


if __name__ == "__main__":
    # Test the VPN manager
    vpn = create_vpn_manager(total_configs=50)

    if vpn:
        print("VPN Manager initialized successfully")
        print(f"Current IP: {vpn.get_current_ip()}")

        # Test rotation
        vpn.rotate_vpn()
        print(f"After rotation, IP: {vpn.get_current_ip()}")

        # Disable
        vpn.disable_vpn()
        print(f"After disable, IP: {vpn.get_current_ip()}")
    else:
        print("VPN Manager not available")
