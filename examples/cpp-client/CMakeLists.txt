cmake_minimum_required(VERSION 3.14)

# socket.io-client-cpp 3.1.0 still declares cmake_minimum_required(2.8).
# Newer CMake (e.g. MSYS2 UCRT) rejects that unless the policy floor is raised.
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)

project(express_cli_monitor_cpp_client LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

FetchContent_Declare(
  socketio_client_cpp
  GIT_REPOSITORY https://github.com/socketio/socket.io-client-cpp.git
  GIT_TAG 3.1.0
  GIT_SUBMODULES_RECURSE TRUE
)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_UNIT_TESTS OFF CACHE BOOL "" FORCE)
set(USE_SUBMODULES ON CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(socketio_client_cpp)

# Upstream 3.1.0 omits <cstdint> in sio_message.h; GCC 13+ no longer pulls it in transitively.
function(apply_sioclient_cstdint_fix target_name)
  if(NOT TARGET ${target_name})
    return()
  endif()
  if(MSVC)
    target_compile_options(${target_name} PRIVATE /FIcstdint)
  elseif(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang|AppleClang")
    target_compile_options(${target_name} PRIVATE -include cstdint)
  endif()
endfunction()

apply_sioclient_cstdint_fix(sioclient)
apply_sioclient_cstdint_fix(sioclient_tls)

# Upstream does not link Winsock on MinGW; MSVC often resolves this via asio pragmas.
function(apply_sioclient_windows_socket_libs target_name)
  if(NOT TARGET ${target_name})
    return()
  endif()
  if(WIN32)
    target_link_libraries(${target_name} PUBLIC ws2_32 mswsock)
  endif()
endfunction()

apply_sioclient_windows_socket_libs(sioclient)
apply_sioclient_windows_socket_libs(sioclient_tls)

add_executable(monitor_cpp_client main.cpp)
target_link_libraries(monitor_cpp_client PRIVATE sioclient)
target_include_directories(monitor_cpp_client PRIVATE
  ${socketio_client_cpp_SOURCE_DIR}/src
)
apply_sioclient_cstdint_fix(monitor_cpp_client)

if(MSVC)
  target_compile_options(monitor_cpp_client PRIVATE /W4)
else()
  target_compile_options(monitor_cpp_client PRIVATE -Wall -Wextra -Wpedantic)
endif()
