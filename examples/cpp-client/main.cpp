/**
 * C++ Socket.IO client sample (socket.io-client-cpp 3.1.0)
 *
 * Terminal 1: npm start
 * Terminal 2: run monitor_cpp_client from examples/cpp-client/build
 *
 * Env: MONITOR_URL (default http://localhost:3000)
 */
#include "sio_client.h"
#include "sio_message.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

namespace {

constexpr const char* kRemoteOutputEvent = "remote-output";
constexpr int kTickIntervalMs = 3000;

std::atomic<bool> g_running{true};
std::mutex g_log_mutex;

void log_line(const std::string& message) {
  std::lock_guard<std::mutex> lock(g_log_mutex);
  std::cout << message << std::endl;
}

void on_signal(int) {
  g_running = false;
}

std::string default_monitor_url() {
  const char* from_env = std::getenv("MONITOR_URL");
  if (from_env != nullptr && from_env[0] != '\0') {
    return from_env;
  }
  return "http://localhost:3000";
}

std::string iso_timestamp() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t t = std::chrono::system_clock::to_time_t(now);
  std::tm tm{};
#if defined(_WIN32)
  gmtime_s(&tm, &t);
#else
  gmtime_r(&t, &tm);
#endif
  std::ostringstream oss;
  oss << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
  return oss.str();
}

sio::message::ptr make_remote_output_payload(const std::string& message) {
  sio::message::ptr payload = sio::object_message::create();
  payload->get_map()["message"] = sio::string_message::create(message);
  return payload;
}

class connection_listener {
 public:
  explicit connection_listener(sio::client& client) : client_(client) {}

  void on_connected() {
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      connect_finished_ = true;
    }
    state_cv_.notify_all();
    log_line("[client] connected: " + client_.get_sessionid());
  }

  void on_close(sio::client::close_reason const& reason) {
    log_line(std::string("[client] disconnected (reason=") +
             std::to_string(static_cast<int>(reason)) + ")");
    g_running = false;
    state_cv_.notify_all();
  }

  void on_fail() {
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      connect_finished_ = true;
    }
    log_line("[client] connect_error");
    g_running = false;
    state_cv_.notify_all();
  }

  void wait_for_connect() {
    std::unique_lock<std::mutex> lock(state_mutex_);
    if (!connect_finished_) {
      state_cv_.wait(lock);
    }
  }

 private:
  sio::client& client_;
  std::mutex state_mutex_;
  std::condition_variable state_cv_;
  bool connect_finished_{false};
};

void emit_ticks(sio::socket::ptr socket) {
  int count = 0;
  while (g_running) {
    std::this_thread::sleep_for(std::chrono::milliseconds(kTickIntervalMs));
    if (!g_running || !socket) {
      break;
    }

    count++;
    std::ostringstream message;
    message << "[remote-cpp] tick " << count << " at " << iso_timestamp();
    socket->emit(kRemoteOutputEvent, make_remote_output_payload(message.str()));
  }
}

}  // namespace

int main() {
  std::signal(SIGINT, on_signal);
#if !defined(_WIN32)
  std::signal(SIGTERM, on_signal);
#endif

  const std::string url = default_monitor_url();
  log_line("[client] connecting to " + url);

  sio::client client;
  connection_listener listener(client);

  client.set_open_listener(std::bind(&connection_listener::on_connected, &listener));
  client.set_close_listener(
      std::bind(&connection_listener::on_close, &listener, std::placeholders::_1));
  client.set_fail_listener(std::bind(&connection_listener::on_fail, &listener));

  client.connect(url);
  listener.wait_for_connect();

  if (!client.opened()) {
    log_line("[client] failed to connect");
    return 1;
  }

  sio::socket::ptr socket = client.socket();
  std::thread ticker(emit_ticks, socket);

  while (g_running && client.opened()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }

  g_running = false;
  if (ticker.joinable()) {
    ticker.join();
  }

  client.sync_close();
  client.clear_con_listeners();
  return 0;
}
