create
    definer = root@localhost procedure SP_RemoveService(IN _ID tinyint)
BEGIN
    delete
    from `mysql-dynamic-cluster`.node_services
    where service_id = _ID;
end;
