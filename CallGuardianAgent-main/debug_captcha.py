#!/usr/bin/env python3
"""Debug CAPTCHA loading from frontend perspective"""

import urllib.request
import json
import urllib.error

def test_captcha_from_frontend():
    """Test CAPTCHA as a browser would"""
    print("=== Testing CAPTCHA from Frontend Perspective ===\n")
    
    frontend_origin = "http://127.0.0.1:5500"
    backend_url = "http://127.0.0.1:8001/captcha"
    
    # Test 1: Basic request
    print("1. Basic CAPTCHA request...")
    try:
        response = urllib.request.urlopen(backend_url)
        data = json.loads(response.read().decode('utf-8'))
        print(f"✓ Status: {response.getcode()}")
        print(f"✓ Response: {data}")
        
        # Validate format
        if 'id' in data and 'question' in data:
            print(f"✓ Valid format: id='{data['id'][:8]}...', question='{data['question']}'")
        else:
            print("✗ Invalid format")
            return False
    except Exception as e:
        print(f"✗ Basic request failed: {e}")
        return False
    
    # Test 2: With Origin header (like browser would send)
    print(f"\n2. Request with Origin: {frontend_origin}...")
    try:
        req = urllib.request.Request(
            backend_url,
            headers={'Origin': frontend_origin}
        )
        response = urllib.request.urlopen(req)
        data = json.loads(response.read().decode('utf-8'))
        print(f"✓ Status: {response.getcode()}")
        print(f"✓ Response: {data}")
    except Exception as e:
        print(f"✗ Origin request failed: {e}")
        return False
    
    # Test 3: Check CORS headers
    print(f"\n3. Checking CORS headers...")
    try:
        req = urllib.request.Request(
            backend_url,
            headers={
                'Origin': frontend_origin,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        )
        response = urllib.request.urlopen(req)
        
        # Check CORS headers
        headers = dict(response.headers)
        cors_headers = {k: v for k, v in headers.items() if k.lower().startswith('access-control')}
        
        if cors_headers:
            print("✓ CORS headers found:")
            for k, v in cors_headers.items():
                print(f"    {k}: {v}")
        else:
            print("! No CORS headers found (might be an issue)")
            
    except Exception as e:
        print(f"✗ CORS check failed: {e}")
        return False
    
    # Test 4: Multiple requests (check uniqueness)
    print(f"\n4. Testing multiple requests for uniqueness...")
    try:
        ids = []
        for i in range(3):
            response = urllib.request.urlopen(backend_url)
            data = json.loads(response.read().decode('utf-8'))
            ids.append(data['id'])
            print(f"  Request {i+1}: {data['question']} (ID: {data['id'][:8]}...)")
        
        if len(set(ids)) == len(ids):
            print("✓ All CAPTCHA IDs are unique")
        else:
            print("✗ Duplicate CAPTCHA IDs found!")
            return False
            
    except Exception as e:
        print(f"✗ Multiple request test failed: {e}")
        return False
    
    return True

if __name__ == "__main__":
    success = test_captcha_from_frontend()
    
    print("\n" + "="*50)
    if success:
        print("✅ BACKEND CAPTCHA IS WORKING PERFECTLY")
        print("\nThe issue must be in the frontend JavaScript.")
        print("Possible issues to check:")
        print("  1. JavaScript errors preventing fetch")
        print("  2. DOM elements not found")
        print("  3. CSS hiding the CAPTCHA")
        print("  4. Async timing issues")
        print("\nNext steps:")
        print("  - Check browser console for errors")
        print("  - Verify DOM elements exist")
        print("  - Test JavaScript execution")
    else:
        print("❌ BACKEND ISSUES FOUND")
        print("Fix backend issues first")
        exit(1)